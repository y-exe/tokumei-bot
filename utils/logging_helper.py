import os
import re
from datetime import datetime, timedelta, timezone
from utils.json_helper import load_json, save_json

def get_log_file_path(date):
    log_dir = f'logs/{date.strftime("%Y/%m")}'
    os.makedirs(log_dir, exist_ok=True)
    return f'{log_dir}/{date.strftime("%d")}.json'

def archive_old_logs():
    archive_file = 'logs/archive.json'
    os.makedirs('logs', exist_ok=True)
    archive_data = load_json(archive_file, {})
    cutoff_date = datetime.now(timezone.utc) - timedelta(days=5)
    
    for root, _, files in os.walk('logs'):
        for filename in files:
            if filename.endswith('.json') and filename != 'archive.json':
                file_path = os.path.join(root, filename)
                match = re.search(r'logs/(\d{4})/(\d{2})/(\d{2})\.json', file_path.replace('\\', '/'))
                if match:
                    try:
                        year, month, day = map(int, match.groups())
                        file_date = datetime(year, month, day, tzinfo=timezone.utc)
                        if file_date < cutoff_date:
                            data = load_json(file_path, {})
                            archive_data.update(data)
                            save_json(archive_file, archive_data)
                            os.remove(file_path)
                    except ValueError:
                        continue
