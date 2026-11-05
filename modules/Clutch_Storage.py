import os
import json
import time
import tempfile
from pathlib import Path
from typing import Dict, Any, Optional



NEST_DIR = Path(".nest")
RECOVERY_FILE = NEST_DIR / "latest_recovery.clutch"
CLUTCH_VERSION = "1.0.0"



def ensure_nest_directory() -> None:
    """Ensure the hidden .nest crash-recovery directory exists."""
    NEST_DIR.mkdir(parents=True, exist_ok=True)



def build_clutch_payload(state: Dict[str, Any]) -> Dict[str, Any]:
    """Construct a standardized .clutch project container."""
    return {
        "format": "GeoCodile.Clutch",
        "version": CLUTCH_VERSION,
        "timestamp": time.time(),
        "dataset_name": state.get("dataset_name", "Untitled"),
        "committed": bool(state.get("committed", False)),
        "columns": state.get("columns", []),
        "meta": state.get("meta", {}),
        "rows": state.get("rows", [])
    }



def save_nest_snapshot(state: Dict[str, Any]) -> str:
    """Atomically write current workspace state to .nest/latest_recovery.clutch."""
    ensure_nest_directory()
    payload = build_clutch_payload(state)

    fd, tmp_path = tempfile.mkstemp(dir=str(NEST_DIR), prefix="snap_", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        os.replace(tmp_path, str(RECOVERY_FILE))
    except Exception:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        raise

    return str(RECOVERY_FILE)



def load_nest_snapshot() -> Optional[Dict[str, Any]]:
    """Read the latest crash-recovery snapshot from .nest if available."""
    if not RECOVERY_FILE.exists():
        return None

    with open(RECOVERY_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)

    if not isinstance(data, dict) or data.get("format") != "GeoCodile.Clutch":
        return None

    return data



def parse_clutch_bytes(raw_bytes: bytes) -> Dict[str, Any]:
    """Validate and parse an uploaded .clutch project file."""
    try:
        data = json.loads(raw_bytes.decode("utf-8"))
    except Exception as exc:
        raise ValueError(f"Corrupted .clutch file: {exc}") from exc

    if not isinstance(data, dict) or data.get("format") != "GeoCodile.Clutch":
        raise ValueError("Invalid .clutch file signature.")

    return data
