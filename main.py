import json
import tempfile
from pathlib import Path
from typing import Any, Dict, Set

from fastapi import Body, FastAPI, File, HTTPException, UploadFile, status
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from modules.Data_Reader import process_file_by_type, to_safe_json, validate_dataframe_payload
from modules.Clutch_Storage import (
    build_clutch_payload,
    load_nest_snapshot,
    parse_clutch_bytes,
    save_nest_snapshot,
)



BASE_DIR = Path(__file__).resolve().parent
MAX_UPLOAD_BYTES = 50 * 1024 * 1024  # 50 MB Stream Limit
CHUNK_SIZE_BYTES = 1024 * 64         # 64 KB Read Chunks

ALLOWED_EXTENSIONS: Set[str] = {
    ".csv",
    ".tsv",
    ".txt",
    ".xlsx",
    ".xls",
    ".xlsm",
    ".ods",
    ".pdf",
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".tif",
    ".tiff",
    ".bmp",
    ".clutch",
}



app = FastAPI(
    title="GeoCodile API",
    version="1.0.0",
    docs_url=None,
    redoc_url=None
)



app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)



def _process_clutch_file(file_path: str) -> str:
    """Read a .clutch project file and return a Data_Reader-compatible JSON string."""
    raw_bytes = Path(file_path).read_bytes()
    clutch_data = parse_clutch_bytes(raw_bytes)

    columns = clutch_data.get("columns", [])
    rows = clutch_data.get("rows", [])

    response_payload = {
        "success": True,
        "file_kind": "clutch",
        "error": None,
        "message": "Clutch project loaded successfully.",
        "info": f"Restored project '{clutch_data.get('dataset_name', 'Untitled')}'.",
        "warnings": [],
        "metadata": {
            "row_count": len(rows),
            "column_count": len(columns),
            "committed": bool(clutch_data.get("committed", False)),
            "column_meta": clutch_data.get("meta", {}),
            "dataset_name": clutch_data.get("dataset_name", "Untitled"),
        },
        "columns": columns,
        "data": rows,
    }
    return to_safe_json(response_payload)



@app.post("/api/data/import")
async def import_data_file(file: UploadFile = File(...)):
    if not file.filename:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Filename is missing or invalid."
        )

    file_suffix = Path(file.filename).suffix.lower()
    if file_suffix not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=f"Unsupported file format: {file_suffix}"
        )

    temp_file = tempfile.NamedTemporaryFile(delete=False, suffix=file_suffix)
    temp_path = Path(temp_file.name)
    total_bytes_received = 0

    try:
        while True:
            chunk = await file.read(CHUNK_SIZE_BYTES)
            if not chunk:
                break

            total_bytes_received += len(chunk)
            if total_bytes_received > MAX_UPLOAD_BYTES:
                raise HTTPException(
                    status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                    detail=f"File exceeds maximum allowed size of {MAX_UPLOAD_BYTES // (1024 * 1024)} MB."
                )

            temp_file.write(chunk)

        temp_file.flush()
        temp_file.close()

        if total_bytes_received == 0:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Uploaded file is empty (0 bytes)."
            )

        if file_suffix == ".clutch":
            json_result_str = await run_in_threadpool(
                _process_clutch_file,
                str(temp_path)
            )
        else:
            json_result_str = await run_in_threadpool(
                process_file_by_type,
                str(temp_path)
            )

        return Response(
            content=json_result_str,
            media_type="application/json",
            status_code=status.HTTP_200_OK
        )

    except HTTPException:
        raise

    except Exception as exc:
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={
                "success": False,
                "error": "Internal processing error occurred.",
                "details": str(exc)
            }
        )

    finally:
        try:
            if not temp_file.closed:
                temp_file.close()
        except Exception:
            pass

        if temp_path.exists():
            try:
                temp_path.unlink()
            except OSError:
                pass

        await file.close()


@app.post("/api/data/validate")
async def validate_data_payload(payload: Dict[str, Any] = Body(...)):
    """Validate editable dataframe values before confirmation."""
    result = await run_in_threadpool(validate_dataframe_payload, payload, False)
    return JSONResponse(content=json.loads(to_safe_json(result)))


@app.post("/api/data/confirm")
async def confirm_data_payload(payload: Dict[str, Any] = Body(...)):
    """Validate and register the dataframe payload for the next plotting stages."""
    result = await run_in_threadpool(validate_dataframe_payload, payload, True)
    if not result.get("success"):
        return JSONResponse(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, content=result)
    return JSONResponse(content=json.loads(to_safe_json(result)))



@app.post("/api/nest/snapshot")
async def api_save_snapshot(payload: Dict[str, Any] = Body(...)):
    """Save current frontend sheet state into .nest/latest_recovery.clutch."""
    try:
        saved_path = await run_in_threadpool(save_nest_snapshot, payload)
        return JSONResponse({
            "status": "success",
            "message": "Workspace snapshot saved to .nest",
            "path": saved_path
        })
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Snapshot failure: {exc}"
        ) from exc



@app.get("/api/nest/recover")
async def api_recover_snapshot():
    """Recover the latest workspace state from .nest if present."""
    data = await run_in_threadpool(load_nest_snapshot)
    if not data:
        return JSONResponse({"status": "empty", "data": None})
    return JSONResponse({"status": "success", "data": data})



@app.post("/api/project/export-clutch")
async def api_export_clutch(payload: Dict[str, Any] = Body(...)):
    """Generate a downloadable .clutch file from current workspace state."""
    clutch_data = build_clutch_payload(payload)
    raw_json = json.dumps(clutch_data, ensure_ascii=False, indent=2)
    raw_name = str(payload.get("dataset_name", "project")).rsplit(".", 1)[0]
    safe_filename = f"{raw_name or 'project'}.clutch"

    return Response(
        content=raw_json.encode("utf-8"),
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": f'attachment; filename="{safe_filename}"'
        }
    )



app.mount("/Script", StaticFiles(directory=BASE_DIR / "Script"), name="scripts")
app.mount("/Style", StaticFiles(directory=BASE_DIR / "Style"), name="styles")



@app.get("/")
async def serve_root_index():
    index_path = BASE_DIR / "index.html"
    if not index_path.is_file():
        raise HTTPException(status_code=404, detail="index.html not found.")
    return Response(
        content=index_path.read_text(encoding="utf-8"),
        media_type="text/html"
    )



if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
