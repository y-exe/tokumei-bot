import copy
import json
import os
import tempfile
import threading
from utils import db


_file_locks = {}
_file_locks_guard = threading.Lock()


def _file_lock(filename):
    path = os.path.normcase(os.path.abspath(filename))
    with _file_locks_guard:
        return _file_locks.setdefault(path, threading.RLock())

def _legacy_filename(filename):
    dirname, basename = os.path.split(filename)
    if dirname == 'detas':
        return basename
    return None


def load_json(filename, default_data):
    if db.is_enabled():
        data = db.load_json_document(filename)
        if data is not None:
            return data

        legacy = _legacy_filename(filename)
        if legacy:
            data = db.load_json_document(legacy)
            if data is not None:
                db.save_json_document(filename, data)
                return data

        file_data = _load_json_file(filename, default_data)
        db.save_json_document(filename, file_data)
        return file_data

    return _load_json_file(filename, default_data)


def _load_json_file(filename, default_data):
    with _file_lock(filename):
        _migrate_legacy_json_file(filename)

        if not os.path.exists(filename):
            _atomic_write_json(filename, default_data)
            return copy.deepcopy(default_data)
        try:
            with open(filename, 'r', encoding='utf-8') as f:
                return json.load(f)
        except (json.JSONDecodeError, FileNotFoundError):
            return copy.deepcopy(default_data)

def save_json(filename, data):
    if db.is_enabled():
        db.save_json_document(filename, data)
        return

    with _file_lock(filename):
        _atomic_write_json(filename, data)


def _atomic_write_json(filename, data):
    dirname = os.path.dirname(filename) or "."
    os.makedirs(dirname, exist_ok=True)
    basename = os.path.basename(filename)
    fd, temporary_path = tempfile.mkstemp(prefix=f".{basename}.", suffix=".tmp", dir=dirname)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=4)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temporary_path, filename)
    except Exception:
        try:
            os.close(fd)
        except OSError:
            pass
        try:
            os.remove(temporary_path)
        except FileNotFoundError:
            pass
        raise


def _migrate_legacy_json_file(filename):
    legacy = _legacy_filename(filename)
    if not legacy or os.path.exists(filename) or not os.path.exists(legacy):
        return

    dirname = os.path.dirname(filename)
    os.makedirs(dirname, exist_ok=True)
    os.replace(legacy, filename)
