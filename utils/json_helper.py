import json
import os
from utils import db

def load_json(filename, default_data):
    if db.is_enabled():
        data = db.load_json_document(filename)
        if data is not None:
            return data

        file_data = _load_json_file(filename, default_data)
        db.save_json_document(filename, file_data)
        return file_data

    return _load_json_file(filename, default_data)


def _load_json_file(filename, default_data):
    if not os.path.exists(filename):
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

    with open(filename, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=4)
