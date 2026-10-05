"""
GeoCodile - Data Ingestion and Validation Module

Author: Abbas "Charlie" Kargozar
Date: 2026-10-02

Description:
    Contains all functions related to reading incoming user data.
    It verifies whether the specified file path exists and ensures 
    the file format is supported by the application before ingestion.
"""


import pandas as pd
from pathlib import Path
from fastapi import HTTPException,status
import magic
# from openpyxl import load_workbook
import pdfplumber


ALLOWED_FILES_CONFIG = { # [future notation] move this part into db
    # image base
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",

    # sheet base
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel",
    ".ods": "application/vnd.oasis.opendocument.spreadsheet", #LibreOffice
    
    # text base
    ".csv": "text/csv",
    ".tsv": "text/tab-separated-values"
}




# [path_checker]: Check file path if exist or not
def path_checker(user_file):
        
    user_file_path = Path(user_file)
        
    if user_file_path.exists():
        if  user_file_path.is_file():
            return user_file_path
        
        if user_file_path.is_dir():
            raise HTTPException(
                status_code=status.HTTP_406_NOT_ACCEPTABLE,
                detail=f"[{user_file_path}] is a directory, please choose a file!"
            )
    else:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No such a file or directory exist!") 

# [type_checker]: Chekes if file type is acceptable or not
def type_checker(checked_path):
    allowed_file_type = list(ALLOWED_FILES_CONFIG.values())
    user_uploaded_file_type = magic.from_file(str(checked_path), mime=True)
    if user_uploaded_file_type in allowed_file_type:
        return {"state":True, "type":user_uploaded_file_type}
    else:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                            detail="GeoCodile Can't handle this file type at the monent [see help]")
        

#[cvs_reader]: Reads CSV and returns a datafram ready for manipulate by pyrolite
def csv_reader(checked_file):
    csv_data = pd.read_csv(
        checked_file,
        na_values=["bdl", "ND", "<0.01", "-","NAN","nan",""],
        encoding="utf-8"
        )
    return csv_data

#[exel_reader]: Reads xls, xlsx and returns a datafram ready for manipulate by pyrolite
def exel_reader(checked_file):
    exel_data = pd.read_excel(
        checked_file,
        na_values=["bdl", "ND", "<0.01", "-","NAN","nan",""],
    )
    return exel_data

# [pdf_reader]: Reads tables data in a pdf file and translate it to dataframe for easy use by pyrolite
def pdf_reader(checked_file) -> list[pd.DataFrame]:

    TABLE_SETTINGS_TEXT = {
        "vertical_strategy": "text",
        "horizontal_strategy": "text",
        "snap_tolerance": 4,
        "intersection_tolerance": 4,
    }

    extracted_tables_raw: list[list[list]] = []

    with pdfplumber.open(checked_file) as pdf:
        for page in pdf.pages:
            # check table with line
            tables = page.extract_tables()

            # try find table without line
            if not tables:
                tables = page.extract_tables(table_settings=TABLE_SETTINGS_TEXT)

            for tbl in tables:
                if not tbl or len(tbl) < 2:
                    continue

                # delete empty rows
                cleaned = [
                    row for row in tbl
                    if any(cell and str(cell).strip() for cell in row)
                ]
                if len(cleaned) >= 2:
                    extracted_tables_raw.append(cleaned)

    if not extracted_tables_raw:
        return []

    # concatenate long tables

    def make_headers(row: list) -> list[str]:
        #make hader with first row
        return [
            str(c).replace("\n", " ").strip() if c else f"col_{i}"
            for i, c in enumerate(row)
        ]

    def make_df(tbl: list[list], columns: list[str] | None = None) -> pd.DataFrame:
        headers = make_headers(tbl[0])
        rows = tbl[1:]
        return pd.DataFrame(rows, columns=headers if columns is None else columns)

    final_dfs: list[pd.DataFrame] = []
    current_df = make_df(extracted_tables_raw[0])

    for next_tbl in extracted_tables_raw[1:]:
        next_headers = make_headers(next_tbl[0])
        next_rows = next_tbl[1:]
        n_cols_match = len(next_tbl[0]) == current_df.shape[1]

        # concatenate multi header long table
        if next_headers == list(current_df.columns):
            continuation = pd.DataFrame(next_rows, columns=current_df.columns)
            current_df = pd.concat([current_df, continuation], ignore_index=True)
        # concatenate single header long table
        elif n_cols_match and not _looks_like_header(next_tbl[0], current_df.columns):
            continuation = pd.DataFrame(next_tbl, columns=current_df.columns)
            current_df = pd.concat([current_df, continuation], ignore_index=True)

        # concatenate multi page wide and long table
        elif len(next_rows) == len(current_df) and not n_cols_match:
            right = pd.DataFrame(next_rows, columns=next_headers)
            current_df = pd.concat(
                [current_df.reset_index(drop=True), right.reset_index(drop=True)],
                axis=1,
            )

        # New table
        else:
            final_dfs.append(current_df)
            current_df = make_df(next_tbl)

    if not current_df.empty:
        final_dfs.append(current_df)

    # Table treatment
    result = []
    for df in final_dfs:
        df = df.map(lambda x: x.replace("\n", " ").strip() if isinstance(x, str) else x)
        df = df.dropna(how="all", axis=1)  # delete empty columns
        df = df.dropna(how="all", axis=0)  # delete empty rows
        if not df.empty:
            result.append(df)

    return result

# [_looks_like_header]: Part of pdf reader > Checks if headers are similar or not
def _looks_like_header(row: list, existing_columns) -> bool:
    row_vals = {str(c).replace("\n", " ").strip() for c in row if c}
    col_vals = set(existing_columns)
    return len(row_vals & col_vals) > 0


# [image_reader]: reads image files and extract table and translate them to the Dataframe
'''
To keep the final app lightweight,
this function should be moved to the online or plugin portion of GeoCodile.
'''
def image_reader(checked_file) -> list[pd.DataFrame]:
    """
    Extracts tables from image files (jpg, jpeg, png) using OCR.
    
    Uses EasyOCR as the backend (no system-level binary required),
    making it suitable for distribution as a Python package.
    
    First run will download OCR model weights (~200MB) automatically.
    
    Args:
        checked_file: Path to the image file (as string or Path object).

    Returns:
        A list of pd.DataFrame objects, one per detected table.
        Returns an empty list if no tables are found.
    """
    try:
        from img2table.ocr import EasyOCR
        from img2table.document import Image as Img2TableImage
    except ImportError:
        raise ImportError(
            "img2table and easyocr are required for image reading. "
            "Install them with: pip install img2table easyocr"
        )

    NA_VALUES = ["bdl", "ND", "<0.01", "-", "NAN", "nan", ""]

    ocr_engine = EasyOCR(lang=["en"])

    img_doc = Img2TableImage(src=str(checked_file))

    # implicit_rows=True helps detect tables without visible border lines,
    # similar to TABLE_SETTINGS_TEXT strategy used in pdf_reader
    extracted = img_doc.extract_tables(
        ocr=ocr_engine,
        implicit_rows=True,
        implicit_columns=False,
        borderless_tables=True,
        min_confidence=50,
    )

    if not extracted:
        return []

    result: list[pd.DataFrame] = []

    for table in extracted:
        df = table.df

        if df is None or df.empty:
            continue

        # Promote first row to header if it looks like a header row
        # (consistent with pdf_reader's make_headers behavior)
        first_row = df.iloc[0].tolist()
        if _looks_like_header(first_row, df.columns):
            df.columns = [
                str(c).replace("\n", " ").strip() if c else f"col_{i}"
                for i, c in enumerate(first_row)
            ]
            df = df.iloc[1:].reset_index(drop=True)

        # Normalize cell values — strip whitespace, replace NA markers
        df = df.map(
            lambda x: x.replace("\n", " ").strip() if isinstance(x, str) else x
        )
        df = df.replace(NA_VALUES, pd.NA)

        # Drop fully empty rows and columns
        df = df.dropna(how="all", axis=1)
        df = df.dropna(how="all", axis=0)

        if not df.empty:
            result.append(df)

    return result





#------------------------Test Section-------------------------#
