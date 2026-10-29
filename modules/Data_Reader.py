"""
GeoCodile - Modular Data Ingestion and Geochemical Pre-processing Library

Design Principles:
    1. Purely functional decomposition: each function performs a single, isolated task.
    2. Framework-agnostic: NO FastAPI or HTTP dependencies.
    3. Lossless ingestion: preserves sample IDs ('001'), censored values ('<0.01', 'bdl'),
       and mixed columns without silent coercion.
    4. Strict JSON boundary: guarantees standard JSON compliance (no NaN/Infinity leaks)
       and uniform response schemas across all file types.
"""

import csv
import json
import logging
import math
import re
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

import pandas as pd

# Optional PDF dependency handled gracefully
try:
    import pdfplumber
except ImportError:
    pdfplumber = None


# =====================================================================
# 0. LOGGING & CONSTANTS CONFIGURATION
# =====================================================================

# Use NullHandler so importing this library never breaks host app logging
logger = logging.getLogger(__name__)
logger.addHandler(logging.NullHandler())

MAX_FILE_MB: int = 50
MAX_HEADER_SCAN_ROWS: int = 15

# Encoding fallback chain (includes cp1256 for Persian Windows CSVs)
CSV_ENCODINGS: Tuple[str, ...] = ("utf-8-sig", "utf-8", "cp1256", "latin-1")

# Standard empty cell representations (excluding geochemical censored markers!)
EMPTY_MARKERS = {"", "nan", "NaN", "NAN", "null", "NULL", "None", "NA", "N/A", "n/a", "-"}

# Geochemical censored / below-detection-limit markers (MUST be preserved for user review)
CENSORED_KEYWORDS = {"bdl", "b.d.l.", "nd", "n.d.", "dl", "<dl", "<lod", "lod"}
CENSORED_REGEX = re.compile(r"^\s*[<>≤≥]\s*\d+([.,]\d+)?\s*$", re.IGNORECASE)

# Numeric pattern (strictly matches clean integers/floats without leading zero IDs like '001')
STRICT_NUMBER_REGEX = re.compile(r"^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$")
LEADING_ZERO_ID_REGEX = re.compile(r"^0\d+$")

# Supported extensions mapped to logical categories
EXT_TO_KIND: Dict[str, str] = {
    # Category 1: Spreadsheets & Delimited Text (Excel, LibreOffice, OnlyOffice, CSV/TSV)
    ".xlsx": "spreadsheet",
    ".xlsm": "spreadsheet",
    ".xls": "spreadsheet",
    ".ods": "spreadsheet",
    ".csv": "csv",
    ".tsv": "csv",
    ".txt": "csv",
    # Category 2: PDF documents
    ".pdf": "pdf",
    # Category 3: Common raster images
    ".jpg": "image",
    ".jpeg": "image",
    ".png": "image",
    ".webp": "image",
    ".tif": "image",
    ".tiff": "image",
    ".bmp": "image",
}

# Binary magic signatures for safe, dependency-free verification
MAGIC_SIGNATURES: List[Tuple[bytes, str]] = [
    (b"%PDF-", "pdf"),
    (b"\xff\xd8\xff", "image"),            # JPEG
    (b"\x89PNG\r\n\x1a\n", "image"),       # PNG
    (b"GIF87a", "image"),                  # GIF
    (b"GIF89a", "image"),                  # GIF
    (b"II*\x00", "image"),                 # TIFF (little-endian)
    (b"MM\x00*", "image"),                 # TIFF (big-endian)
    (b"BM", "image"),                      # BMP
    (b"PK\x03\x04", "zip_container"),      # XLSX, XLSM, ODS (ZIP-based XML)
    (b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1", "ole_container"),  # Legacy XLS
]

# Canonical Major Oxides in Geochemistry
CANONICAL_OXIDES: Dict[str, str] = {
    "sio2": "SiO2",
    "tio2": "TiO2",
    "al2o3": "Al2O3",
    "fe2o3": "Fe2O3",
    "fe2o3t": "Fe2O3T",
    "feot": "FeOT",
    "feo": "FeO",
    "mno": "MnO",
    "mgo": "MgO",
    "cao": "CaO",
    "na2o": "Na2O",
    "k2o": "K2O",
    "p2o5": "P2O5",
    "cr2o3": "Cr2O3",
    "nio": "NiO",
    "bao": "BaO",
    "sro": "SrO",
    "zrO2": "ZrO2",
    "so3": "SO3",
    "h2o": "H2O",
    "h2o+": "H2O+",
    "h2o-": "H2O-",
    "co2": "CO2",
    "loi": "LOI",
    "total": "Total",
    "sum": "Total",
}

# Canonical Chemical Elements (Periodic Table)
CANONICAL_ELEMENTS: Dict[str, str] = {
    el.lower(): el for el in [
        "H", "He", "Li", "Be", "B", "C", "N", "O", "F", "Ne",
        "Na", "Mg", "Al", "Si", "P", "S", "Cl", "Ar", "K", "Ca",
        "Sc", "Ti", "V", "Cr", "Mn", "Fe", "Co", "Ni", "Cu", "Zn",
        "Ga", "Ge", "As", "Se", "Br", "Kr", "Rb", "Sr", "Y", "Zr",
        "Nb", "Mo", "Tc", "Ru", "Rh", "Pd", "Ag", "Cd", "In", "Sn",
        "Sb", "Te", "I", "Xe", "Cs", "Ba", "La", "Ce", "Pr", "Nd",
        "Pm", "Sm", "Eu", "Gd", "Tb", "Dy", "Ho", "Er", "Tm", "Yb",
        "Lu", "Hf", "Ta", "W", "Re", "Os", "Ir", "Pt", "Au", "Hg",
        "Tl", "Pb", "Bi", "Po", "At", "Rn", "Fr", "Ra", "Ac", "Th",
        "Pa", "U"
    ]
}

# Common Sample Identifier column keywords
SAMPLE_ID_KEYWORDS = {
    "sample", "sampleid", "sample_id", "sample no", "sample_no", "samplename",
    "sample_name", "id", "name", "code", "specimen", "label", "station",
    "hole_id", "holeid", "dhh", "نمونه", "نام نمونه", "کد نمونه", "شماره نمونه"
}


# =====================================================================
# 1. STANDARDIZED RESPONSE BUILDERS & ERROR SANITIZATION
# =====================================================================

def sanitize_error_message(error_text: str, file_path: Optional[ Path ] = None) -> str:
    """
    Strip internal server directory paths from exception messages
    to prevent sensitive path disclosure to the frontend.
    """
    cleaned = str(error_text)
    if file_path is not None:
        cleaned = cleaned.replace(str(file_path), file_path.name)
        cleaned = cleaned.replace(str(file_path.resolve()), file_path.name)
    # Remove generic Unix/Windows absolute path patterns
    cleaned = re.sub(r"([A-Za-z]:\\[^\s'\"]+|/[^\s'\"]+/)", "", cleaned)
    return cleaned.strip()


def build_error_response(
    error_msg: str,
    info: Optional[str] = None,
    message: Optional[str] = None,
    file_kind: Optional[str] = None
) -> Dict[str, Any]:
    """
    Create a uniform error dictionary guaranteed to have consistent keys for the frontend.
    """
    return {
        "success": False,
        "file_kind": file_kind,
        "error": error_msg,
        "message": message or error_msg,
        "info": info or "",
        "warnings": [],
        "metadata": {},
        "columns": [],
        "data": [],
    }


def build_success_response(
    file_kind: str,
    columns: List[str],
    data: List[Dict[str, Any]],
    metadata: Dict[str, Any],
    warnings: List[str],
    message: str = "File processed successfully."
) -> Dict[str, Any]:
    """
    Create a uniform success dictionary for the frontend.
    """
    return {
        "success": True,
        "file_kind": file_kind,
        "error": None,
        "message": message,
        "info": "",
        "warnings": warnings,
        "metadata": metadata,
        "columns": columns,
        "data": data,
    }


def to_safe_json(payload: Dict[str, Any]) -> str:
    """
    Serialize dictionary to strict JSON string (converts any residual NaN/Inf to null).
    """
    def _clean_json_value(val: Any) -> Any:
        if isinstance(val, float) and (math.isnan(val) or math.isinf(val)):
            return None
        if isinstance(val, dict):
            return {str(k): _clean_json_value(v) for k, v in val.items()}
        if isinstance(val, list):
            return [_clean_json_value(v) for v in val]
        return val

    safe_payload = _clean_json_value(payload)
    return json.dumps(safe_payload, ensure_ascii=False, allow_nan=False)


# =====================================================================
# 2. FILE VALIDATION & TYPE DETECTION (MODULES 1, 2, 3)
# =====================================================================

def read_file_header_bytes(path: Path, num_bytes: int = 16) -> bytes:
    """Read the first N bytes of a file to check its binary magic signature."""
    with path.open("rb") as f:
        return f.read(num_bytes)


def detect_magic_container(header_bytes: bytes) -> Optional[str]:
    """Match file header bytes against known binary signatures."""
    if header_bytes.startswith(b"RIFF") and b"WEBP" in header_bytes[:16]:
        return "image"
    for signature, kind in MAGIC_SIGNATURES:
        if header_bytes.startswith(signature):
            return kind
    return None


def detect_file_kind(path: Path) -> Optional[str]:
    """
    Reliably detect file category ('spreadsheet', 'csv', 'pdf', 'image')
    combining extension and binary header inspection without fragile libmagic calls.
    """
    ext = path.suffix.lower()
    ext_kind = EXT_TO_KIND.get(ext)

    try:
        header = read_file_header_bytes(path)
    except OSError:
        return None

    magic_kind = detect_magic_container(header)

    # Verify consistency between binary signature and extension
    if magic_kind in ("pdf", "image"):
        return magic_kind
    if magic_kind in ("zip_container", "ole_container"):
        return "spreadsheet" if ext_kind == "spreadsheet" else None
    if ext_kind in ("csv", "spreadsheet", "pdf", "image"):
        return ext_kind

    return None


def validate_input_file(file_path: str) -> Dict[str, Any]:
    """
    Validate file existence, regular file status, size limits, and supported format.
    """
    path = Path(file_path)

    if not path.exists():
        return build_error_response("File not found.")
    if path.is_dir():
        return build_error_response("The specified path is a directory, not a file.")
    if not path.is_file():
        return build_error_response("Invalid file resource.")

    try:
        size_bytes = path.stat().st_size
    except OSError as exc:
        return build_error_response(sanitize_error_message(str(exc), path))

    if size_bytes == 0:
        return build_error_response("The uploaded file is empty (0 bytes).")

    max_bytes = MAX_FILE_MB * 1024 * 1024
    if size_bytes > max_bytes:
        return build_error_response(f"File size exceeds the maximum allowed limit of {MAX_FILE_MB} MB.")

    kind = detect_file_kind(path)
    if kind is None:
        return build_error_response("Unsupported or unrecognized file format.")

    return {"success": True, "kind": kind, "path": path}


# =====================================================================
# 3. GEOCHEMICAL HEADER & ELEMENT RECOGNITION ENGINE (MODULE 5 CORE)
# =====================================================================

def parse_chemical_header(raw_header: str) -> Dict[str, Optional[str]]:
    """
    Analyze a column name to detect if it represents an oxide, trace element, or sample ID.
    Normalizes variations like 'Si_O2', 'SIO2 (%)', 'sio2_wt%', 'La_ppm', 'Ba (ug/g)'.
    """
    original = str(raw_header).strip()
    if not original:
        return {"original": original, "normalized": "col", "category": "unknown", "unit": None}

    # Check if it is a Sample ID column
    clean_lower = re.sub(r"[\s_\-]+", " ", original.lower()).strip()
    if clean_lower in SAMPLE_ID_KEYWORDS or any( clean_lower.startswith(k + " ") for k in ("sample", "id", "کد", "نام") ):
        return {"original": original, "normalized": original, "category": "sample_id", "unit": None}

    # Extract explicit unit if present: ppm, ppb, wt%, %, ug/g, mg/kg
    unit_match = re.search(r"(?:\b|_|\(|\s)(wt\.?\s*%|%|ppm|ppb|ug/g|µg/g|mg/kg|g/t)(?:\b|\)|\s|$)", original, re.IGNORECASE)
    detected_unit = unit_match.group(1).lower().replace(" ", "") if unit_match else None
    if detected_unit in ("wt%", "wt.%"):
        detected_unit = "%"

    # Strip units, brackets, and separators to isolate chemical token
    token = original
    if unit_match:
        token = token[:unit_match.start()] + token[unit_match.end():]
    token = re.sub(r"[\(\)\[\]\{\}_\-\s\.]+", "", token)

    # Check against canonical oxides (e.g., Si_O2 -> sio2 -> SiO2)
    token_lower = token.lower()
    if token_lower in CANONICAL_OXIDES:
        norm_name = CANONICAL_OXIDES[token_lower]
        unit = detected_unit or ("%" if norm_name != "Total" else "%")
        return {"original": original, "normalized": norm_name, "category": "oxide", "unit": unit}

    # Check against canonical chemical elements (e.g., La_ppm -> La)
    if token_lower in CANONICAL_ELEMENTS:
        norm_name = CANONICAL_ELEMENTS[token_lower]
        unit = detected_unit or "ppm"
        return {"original": original, "normalized": norm_name, "category": "element", "unit": unit}

    # Handle element + atomic mass isotopes or suffixes like 'Pb206', 'Fe_tot'
    el_prefix_match = re.match(r"^([A-Za-z]{1,2})(?:\d+|\b)", token)
    if el_prefix_match and el_prefix_match.group(1).lower() in CANONICAL_ELEMENTS and detected_unit:
        norm_name = CANONICAL_ELEMENTS[el_prefix_match.group(1).lower()]
        return {"original": original, "normalized": norm_name, "category": "element", "unit": detected_unit}

    return {"original": original, "normalized": original, "category": "other", "unit": detected_unit}


def score_row_as_geochemical_header(row_values: List[Any]) -> int:
    """
    Calculate a confidence score indicating how likely a row is the true table header.
    """
    score = 0
    seen_tokens = set()

    for cell in row_values:
        if cell is None:
            continue
        text = str(cell).strip()
        if not text or text in EMPTY_MARKERS:
            continue
        # Pure numbers are data, not chemical headers
        if STRICT_NUMBER_REGEX.match(text):
            score -= 1
            continue

        parsed = parse_chemical_header(text)
        cat = parsed["category"]
        if cat in ("oxide", "element") and parsed["normalized"] not in seen_tokens:
            score += 3
            seen_tokens.add(parsed["normalized"])
        elif cat == "sample_id":
            score += 2

    return score


def locate_header_row_index(raw_df: pd.DataFrame) -> int:
    """
    Scan the top rows of an unindexed DataFrame to find the row containing chemical elements/oxides.
    """
    best_idx = 0
    best_score = -999
    limit = min( len(raw_df), MAX_HEADER_SCAN_ROWS )

    for idx in range(limit):
        row_list = raw_df.iloc[idx].tolist()
        score = score_row_as_geochemical_header(row_list)
        if score > best_score:
            best_score = score
            best_idx = idx

    # Only shift header down if we found recognizable geochemical columns (score >= 3)
    return best_idx if best_score >= 3 else 0


# =====================================================================
# 4. VALUE & TABLE SANITIZATION (LOSSLESS CLEANING)
# =====================================================================

def make_unique_column_names(raw_columns: List[Any]) -> List[str]:
    """
    Ensure every column has a non-empty, unique string name so duplicate headers
    never overwrite each other during JSON serialization.
    """
    unique_cols: List[str] = []
    counts: Dict[str, int] = {}

    for idx, col in enumerate(raw_columns):
        base = str(col).replace("\n", " ").strip() if col is not None else ""
        if not base or base.lower().startswith("unnamed:") or base in EMPTY_MARKERS:
            base = f"col_{idx + 1}"

        if base not in counts:
            counts[base] = 1
            unique_cols.append(base)
        else:
            counts[base] += 1
            unique_cols.append(f"{base}_{counts[base]}")

    return unique_cols


def parse_single_cell_value(val: Any, is_sample_id_col: bool = False) -> Tuple[Any, bool]:
    """
    Clean a single cell without losing data:
      - Returns (cleaned_value, is_censored_flag)
      - Keeps Sample IDs ('001', 'S1') as strings.
      - Keeps censored values ('<0.01', 'bdl') as strings and flags them.
      - Converts pure numeric strings ('45.2') to float/int.
    """
    if val is None or (isinstance(val, float) and (math.isnan(val) or math.isinf(val))):
        return None, False

    text = str(val).replace("\n", " ").strip()
    if text in EMPTY_MARKERS:
        return None, False

    if is_sample_id_col:
        return text, False

    # Check if value is a geochemical detection-limit / censored marker
    if text.lower() in CENSORED_KEYWORDS or CENSORED_REGEX.match(text):
        return text, True

    # Preserve leading-zero identifiers (e.g., '0012') as string even in non-ID columns
    if LEADING_ZERO_ID_REGEX.match(text):
        return text, False

    # Normalize comma decimal separators ONLY when unambiguous (e.g., '12,34' -> '12.34')
    normalized_num = text.replace(",", ".") if re.match(r"^[+-]?\d+,\d+$", text) else text

    if STRICT_NUMBER_REGEX.match(normalized_num):
        try:
            if "." in normalized_num or "e" in normalized_num.lower():
                num_val = float(normalized_num)
                return (None, False) if (math.isnan(num_val) or math.isinf(num_val)) else (num_val, False)
            return int(normalized_num), False
        except ValueError:
            return text, False

    return text, False


def detect_sample_id_column(columns: List[str], parsed_headers: List[Dict[str, Optional[str]]], df: pd.DataFrame) -> Optional[str]:
    """
    Identify the Sample Name / ID column either by header name or by inspecting the leftmost string column.
    """
    # 1. Explicit header match
    for col, info in zip(columns, parsed_headers):
        if info["category"] == "sample_id":
            return col

    # 2. Heuristic fallback: check first two columns for alphanumeric sample codes
    for col in columns[:2]:
        info = next((h for h in parsed_headers if h["original"] == col), None)
        if info and info["category"] in ("oxide", "element"):
            continue
        series = df[col].dropna().astype(str).str.strip()
        series = series[~series.isin(EMPTY_MARKERS)]
        if len(series) == 0:
            continue
        # If majority of values are non-pure numbers or leading-zero codes, treat as Sample ID
        non_numeric_count = sum(
            not STRICT_NUMBER_REGEX.match(v) or bool(LEADING_ZERO_ID_REGEX.match(v))
            for v in series
        )
        if non_numeric_count / len(series) >= 0.6:
            return col

    return None


def structure_geochemical_dataframe(raw_df: pd.DataFrame) -> Tuple[List[str], List[Dict[str, Any]], Dict[str, Any], List[str]]:
    """
    Transform a raw, unindexed DataFrame into cleaned records and rich geochemical metadata.
    """
    warnings: List[str] = []

    # Drop completely empty rows and columns first
    df = raw_df.dropna(how="all", axis=0).dropna(how="all", axis=1).reset_index(drop=True)
    if df.empty:
        return [], [], {}, ["The table contains no usable data."]

    # Locate the row containing chemical elements/oxides
    header_idx = locate_header_row_index(df)
    if header_idx > 0:
        warnings.append(f"Header row automatically detected at row {header_idx + 1}; preceding rows were skipped.")

    raw_headers = df.iloc[header_idx].tolist()
    data_df = df.iloc[header_idx + 1:].reset_index(drop=True)

    # Remove fully empty rows/columns after slicing header
    data_df = data_df.replace(list(EMPTY_MARKERS), pd.NA).dropna(how="all", axis=0).dropna(how="all", axis=1)
    if data_df.empty:
        return [], [], {}, ["Header row found, but no sample rows exist below it."]

    # Align headers with remaining non-empty columns
    kept_col_positions = [df.columns.get_loc(c) for c in data_df.columns]
    aligned_raw_headers = [raw_headers[pos] for pos in kept_col_positions]
    unique_columns = make_unique_column_names(aligned_raw_headers)
    data_df.columns = unique_columns

    # Analyze headers for oxides, trace elements, and units
    parsed_headers = [parse_chemical_header(col) for col in unique_columns]
    sample_id_col = detect_sample_id_column(unique_columns, parsed_headers, data_df)

    # Build clean records and track censored values
    records: List[Dict[str, Any]] = []
    censored_count = 0

    for _, row in data_df.iterrows():
        record: Dict[str, Any] = {}
        non_null_cells = 0
        for col in unique_columns:
            val, is_censored = parse_single_cell_value(row[col], is_sample_id_col=(col == sample_id_col))
            if is_censored:
                censored_count += 1
            if val is not None:
                non_null_cells += 1
            record[col] = val
        if non_null_cells > 0:
            records.append(record)

    oxides = [h["normalized"] for h in parsed_headers if h["category"] == "oxide" and h["normalized"]]
    elements = [h["normalized"] for h in parsed_headers if h["category"] == "element" and h["normalized"]]

    if censored_count > 0:
        warnings.append(
            f"Detected {censored_count} censored/below-detection-limit values (e.g., '<0.01', 'bdl'). "
            "They are preserved as-is for user review."
        )

    metadata = {
        "header_row_index": header_idx,
        "sample_id_column": sample_id_col,
        "row_count": len(records),
        "column_count": len(unique_columns),
        "detected_oxides": oxides,
        "detected_elements": elements,
        "censored_values_count": censored_count,
        "column_mapping": {
            h["original"]: {
                "normalized_name": h["normalized"],
                "category": (
                    "sample_id" if h["original"] == sample_id_col else h["category"]
                ),
                "unit": h["unit"],
            }
            for h in parsed_headers
        },
    }

    return unique_columns, records, metadata, warnings


# =====================================================================
# 5. TABULAR READERS: CSV, EXCEL, LIBREOFFICE, ONLYOFFICE (MODULE 5)
# =====================================================================

def sniff_csv_delimiter(sample_text: str, ext: str) -> str:
    """Detect delimiter reliably for CSV/TSV/TXT files."""
    if ext == ".tsv":
        return "\t"
    try:
        dialect = csv.Sniffer().sniff(sample_text, delimiters=[",", ";", "\t", "|"])
        return dialect.delimiter
    except csv.Error:
        return ","


def read_delimited_file_raw(path: Path) -> Tuple[pd.DataFrame, str]:
    """
    Read CSV/TSV/TXT as raw strings (header=None, dtype=str) using fallback encodings
    including cp1256 for Persian support.
    """
    last_decode_error: Optional[Exception] = None

    for encoding in CSV_ENCODINGS:
        try:
            with path.open("r", encoding=encoding, errors="strict") as f:
                sample = f.read(4096)
            delimiter = sniff_csv_delimiter(sample, path.suffix.lower())
            df = pd.read_csv(
                path,
                sep=delimiter,
                header=None,
                dtype=str,
                keep_default_na=False,
                encoding=encoding,
                engine="python",
            )
            return df, encoding
        except UnicodeDecodeError as decode_err:
            last_decode_error = decode_err
            continue

    raise ValueError(f"Unable to decode text file with supported encodings: {last_decode_error}")


def select_spreadsheet_engine(ext: str) -> Optional[str]:
    """Select the appropriate pandas Excel engine based on file extension."""
    if ext in (".xlsx", ".xlsm"):
        return "openpyxl"
    if ext == ".ods":
        return "odf"
    if ext == ".xls":
        return "xlrd"
    return None


def read_spreadsheet_sheets_raw(path: Path) -> Dict[str, pd.DataFrame]:
    """
    Read all sheets from Excel (.xlsx, .xls) or OpenDocument (.ods) as raw string DataFrames.
    """
    ext = path.suffix.lower()
    engine = select_spreadsheet_engine(ext)
    sheets_dict = pd.read_excel(
        path,
        sheet_name=None,  # Read all sheets so none are silently ignored
        header=None,
        dtype=str,
        keep_default_na=False,
        engine=engine,
    )
    return sheets_dict


def handle_tabular_data(file_path: str, file_kind: str = "spreadsheet") -> Dict[str, Any]:
    """
    Module [5]: Read CSV, XLS, XLSX, ODS (LibreOffice/OnlyOffice), detect geochemical
    elements/sample IDs, and return frontend-ready JSON dictionary.
    """
    path = Path(file_path)
    warnings: List[str] = []

    try:
        if file_kind == "csv":
            raw_df, used_encoding = read_delimited_file_raw(path)
            cols, records, meta, table_warnings = structure_geochemical_dataframe(raw_df)
            warnings.extend(table_warnings)
            meta["encoding"] = used_encoding
            meta["sheets"] = ["default"]
            meta["active_sheet"] = "default"
        else:
            sheets_dict = read_spreadsheet_sheets_raw(path)
            non_empty_sheets = {
                name: sdf for name, sdf in sheets_dict.items()
                if not sdf.replace(list(EMPTY_MARKERS), pd.NA).dropna(how="all").empty
            }
            if not non_empty_sheets:
                return build_error_response("The spreadsheet contains no non-empty sheets.", file_kind=file_kind)

            sheet_names = list(non_empty_sheets.keys())
            active_sheet = sheet_names[0]
            if len(sheet_names) > 1:
                warnings.append(
                    f"Multiple sheets detected ({', '.join(sheet_names)}). "
                    f"Loaded '{active_sheet}' as primary; other sheets are listed in metadata."
                )

            cols, records, meta, table_warnings = structure_geochemical_dataframe(non_empty_sheets[active_sheet])
            warnings.extend(table_warnings)
            meta["sheets"] = sheet_names
            meta["active_sheet"] = active_sheet

        if not records:
            return build_error_response("No valid geochemical data rows could be extracted.", file_kind=file_kind)

        return build_success_response(
            file_kind=file_kind,
            columns=cols,
            data=records,
            metadata=meta,
            warnings=warnings,
        )

    except ImportError as imp_err:
        return build_error_response(
            f"Missing required spreadsheet reader dependency: {sanitize_error_message(str(imp_err), path)}",
            file_kind=file_kind,
        )
    except Exception as exc:
        logger.debug("Tabular ingestion failed", exc_info=True)
        return build_error_response(
            sanitize_error_message(f"{type(exc).__name__}: {exc}", path),
            file_kind=file_kind,
        )


# =====================================================================
# 6. OPTIMIZED PDF TABLE EXTRACTOR (MODULE 6)
# =====================================================================

PDF_TEXT_STRATEGY_SETTINGS = {
    "vertical_strategy": "text",
    "horizontal_strategy": "text",
    "snap_tolerance": 4,
    "intersection_tolerance": 4,
}


def clean_pdf_raw_table(table: List[List[Any]]) -> List[List[str]]:
    """Clean cell strings and discard blank rows from a raw pdfplumber table."""
    cleaned_rows: List[List[str]] = []
    for row in table:
        if not row:
            continue
        norm_row = [str(cell).replace("\n", " ").strip() if cell is not None else "" for cell in row]
        if any(cell not in EMPTY_MARKERS for cell in norm_row):
            cleaned_rows.append(norm_row)
    return cleaned_rows


def extract_raw_tables_from_pdf(path: Path) -> List[List[List[str]]]:
    """Extract all candidate tables across PDF pages using line first, then text strategy."""
    if pdfplumber is None:
        raise ImportError("pdfplumber is required for PDF table extraction.")

    extracted: List[List[List[str]]] = []
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            tables = page.extract_tables()
            if not tables:
                tables = page.extract_tables(table_settings=PDF_TEXT_STRATEGY_SETTINGS)

            for tbl in tables or []:
                cleaned = clean_pdf_raw_table(tbl)
                if len(cleaned) >= 2:
                    extracted.append(cleaned)

    return extracted


def rows_share_header_signature(row_a: List[str], row_b: List[str]) -> bool:
    """Check if two header rows from consecutive PDF pages represent the same table header."""
    set_a = {c.lower() for c in row_a if c and c not in EMPTY_MARKERS}
    set_b = {c.lower() for c in row_b if c and c not in EMPTY_MARKERS}
    if not set_a or not set_b:
        return False
    overlap = len(set_a & set_b) / max(len(set_a), len(set_b))
    return overlap >= 0.6


def merge_multipage_pdf_tables(raw_tables: List[List[List[str]]]) -> List[pd.DataFrame]:
    """
    Intelligently stitch multi-page vertical continuations and horizontal splits into unified DataFrames.
    """
    if not raw_tables:
        return []

    merged_blocks: List[List[List[str]]] = [raw_tables[0]]

    for next_tbl in raw_tables[1:]:
        curr_tbl = merged_blocks[-1]
        curr_cols = len(curr_tbl[0])
        next_cols = len(next_tbl[0])

        # Case 1: Vertical continuation with repeated header row
        if next_cols == curr_cols and rows_share_header_signature(curr_tbl[0], next_tbl[0]):
            curr_tbl.extend(next_tbl[1:])

        # Case 2: Vertical continuation without repeated header row
        elif next_cols == curr_cols and score_row_as_geochemical_header(next_tbl[0]) < 2:
            curr_tbl.extend(next_tbl)

        # Case 3: Horizontal split table across facing pages (same row count, different columns)
        elif len(next_tbl) == len(curr_tbl) and next_cols != curr_cols:
            for r_idx in range(len(curr_tbl)):
                curr_tbl[r_idx].extend(next_tbl[r_idx])

        # Case 4: Distinct new table
        else:
            merged_blocks.append(next_tbl)

    return [pd.DataFrame(block, dtype=str) for block in merged_blocks if len(block) >= 2]


def handle_pdf_data(file_path: str, file_kind: str = "pdf") -> Dict[str, Any]:
    """
    Module [6]: Extract tables from PDF, run geochemical element/sample ID recognition
    (Module 5 rules), and return structured JSON.
    """
    path = Path(file_path)
    try:
        raw_tables = extract_raw_tables_from_pdf(path)
        if not raw_tables:
            return build_error_response("No tabular data could be found in the PDF file.", file_kind=file_kind)

        candidate_dfs = merge_multipage_pdf_tables(raw_tables)

        # Score each extracted table by its geochemical relevance and pick the best primary table
        processed_tables: List[Dict[str, Any]] = []
        for idx, df in enumerate(candidate_dfs):
            cols, records, meta, tbl_warnings = structure_geochemical_dataframe(df)
            if records:
                geo_score = len(meta.get("detected_oxides", [])) * 2 + len(meta.get("detected_elements", []))
                processed_tables.append({
                    "table_index": idx,
                    "columns": cols,
                    "data": records,
                    "metadata": meta,
                    "warnings": tbl_warnings,
                    "score": geo_score,
                })

        if not processed_tables:
            return build_error_response("Tables were found in the PDF, but none contained valid rows.", file_kind=file_kind)

        # Sort so the richest geochemical table is returned as primary
        processed_tables.sort(key=lambda item: (item["score"], len(item["data"])), reverse=True)
        primary = processed_tables[0]
        warnings = list(primary["warnings"])

        if len(processed_tables) > 1:
            warnings.append(
                f"Extracted {len(processed_tables)} tables from PDF. "
                "The primary geochemical table is loaded; others are available in metadata['additional_tables']."
            )

        metadata = primary["metadata"]
        metadata["total_tables_extracted"] = len(processed_tables)
        metadata["additional_tables"] = [
            {
                "table_index": t["table_index"],
                "columns": t["columns"],
                "row_count": len(t["data"]),
                "data": t["data"],
            }
            for t in processed_tables[1:]
        ]

        return build_success_response(
            file_kind=file_kind,
            columns=primary["columns"],
            data=primary["data"],
            metadata=metadata,
            warnings=warnings,
        )

    except Exception as exc:
        logger.debug("PDF ingestion failed", exc_info=True)
        return build_error_response(
            sanitize_error_message(f"{type(exc).__name__}: {exc}", path),
            file_kind=file_kind,
        )


# =====================================================================
# 7. IMAGE PLACEHOLDER HANDLER (MODULE 7)
# =====================================================================

def handle_image_data(file_path: str, file_kind: str = "image") -> Dict[str, Any]:
    """
    Module [7]: Return the exact requested notice for image files while maintaining
    a uniform JSON response schema for the frontend.
    """
    msg = "درحال توسعه این بخش هستیم"
    info = "این بخش به علت حجم بالای پردازشی تنها به صورت آنلاین و محدود برای کاربران در دسترس خواهد بود."
    return {
        "success": False,
        "file_kind": file_kind,
        "error": msg,
        "message": msg,
        "info": info,
        "warnings": [],
        "metadata": {},
        "columns": [],
        "data": [],
    }


# =====================================================================
# 8. ROUTER & PUBLIC API BOUNDARY (MODULE 4)
# =====================================================================

_CATEGORY_HANDLERS: Dict[str, Callable[[str, str], Dict[str, Any]]] = {
    "spreadsheet": handle_tabular_data,
    "csv": handle_tabular_data,
    "pdf": handle_pdf_data,
    "image": handle_image_data,
}


def process_file(file_path: str) -> Dict[str, Any]:
    """
    Validate file, detect category, and dispatch to the corresponding module handler.
    Returns a Python dictionary.
    """
    validation = validate_input_file(file_path)
    if not validation["success"]:
        return validation

    kind = validation["kind"]
    handler = _CATEGORY_HANDLERS.get(kind)
    if handler is None:
        return build_error_response("No handler registered for this file type.", file_kind=kind)

    return handler(file_path, kind)


def process_file_by_type(file_path: str) -> str:
    """
    Main public entrypoint for the application backend.
    Always returns a strict, valid UTF-8 JSON string ready for Frontend Fetch API.
    """
    result_dict = process_file(file_path)
    return to_safe_json(result_dict)
