"""
GeoCodile - Data Ingestion and Validation Module

Author: Abbas "Charlie" Kargozar
Date: 2026-10-02

Description:
    Contains all functions related to reading incoming user data.
    It verifies whether the specified file path exists and ensures 
    the file format is supported by the application before ingestion.
"""


import pandas
from pathlib import Path
from fastapi import HTTPException,status
import magic


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
        

