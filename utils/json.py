import json
import os
from utils import db

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
    _migrate_legacy_json_file(filename)

    if not os.path.exists(filename):
        dirname = os.path.dirname(filename)
        if dirname:
            os.makedirs(dirname, exist_ok=True)
        with open(filename, 'w', encoding='utf-8') as f:
            json.dump(default_data, f, indent=4)
        return default_data
    try:
        with open(filename, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (json.JSONDecodeError, FileNotFoundError):
        return default_data

def save_json(filename, data):
    if db.is_enabled():
        db.save_json_document(filename, data)
        return

    dirname = os.path.dirname(filename)
    if dirname:
        os.makedirs(dirname, exist_ok=True)
    with open(filename, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=4)


def _migrate_legacy_json_file(filename):
    legacy = _legacy_filename(filename)
    if not legacy or os.path.exists(filename) or not os.path.exists(legacy):
        return

    dirname = os.path.dirname(filename)
    os.makedirs(dirname, exist_ok=True)
    os.replace(legacy, filename)
