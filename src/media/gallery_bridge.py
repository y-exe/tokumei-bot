import ipaddress
import json
import logging
import socket
import sys
from urllib.parse import urlsplit


def public_address(value):
    address = ipaddress.ip_address(value.split("%")[0])
    if not address.is_global or address.is_multicast or address.is_reserved:
        return False
    if address.version == 6:
        return address in ipaddress.ip_network("2000::/3") and not (
            address in ipaddress.ip_network("2001::/32")
            or address in ipaddress.ip_network("2001:db8::/32")
            or address in ipaddress.ip_network("2002::/16")
        )
    return not any(address in ipaddress.ip_network(network) for network in (
        "0.0.0.0/8", "192.0.0.0/16", "198.18.0.0/15", "198.51.0.0/16", "203.0.0.0/16",
    ))


def public_url(value, blocked):
    if not isinstance(value, str) or len(value) > 4000:
        raise ValueError("url")
    url = urlsplit(value)
    if url.scheme != "https" or not url.hostname or url.username or url.password or url.port not in (None, 443):
        raise ValueError("url")
    host = url.hostname.lower().rstrip(".")
    if any(host == domain or host.endswith("." + domain) for domain in blocked):
        raise ValueError("blocked")
    return value


def protect_network(blocked):
    original_dns = socket.getaddrinfo
    original_connect = socket.socket.connect

    def dns(host, port, *args, **kwargs):
        host = host.decode("ascii") if isinstance(host, bytes) else host
        try:
            ipaddress.ip_address(host)
        except ValueError:
            host = host if host.endswith(".") else host + "."
        rows = original_dns(host, port, *args, **kwargs)
        if not rows or any(not public_address(row[4][0]) for row in rows):
            raise OSError("blocked")
        return rows

    def connect(sock, address):
        if not isinstance(address, tuple) or address[1] != 443 or not public_address(address[0]):
            raise OSError("blocked")
        return original_connect(sock, address)

    def connect_ex(sock, address):
        try:
            connect(sock, address)
            return 0
        except OSError:
            return 13

    socket.getaddrinfo = dns
    socket.socket.connect = connect
    socket.socket.connect_ex = connect_ex
    socket.setdefaulttimeout(8)

    import requests
    original_send = requests.adapters.HTTPAdapter.send
    count = 0

    def send(adapter, request, **kwargs):
        nonlocal count
        public_url(request.url, blocked)
        count += 1
        if count > 20:
            raise OSError("request-limit")
        response = original_send(adapter, request, **kwargs)
        raw = response.raw
        original_read, original_stream = raw.read, raw.stream
        received = 0

        def check(data):
            nonlocal received
            received += len(data)
            if received > 4 * 1024 * 1024:
                response.close()
                raise OSError("size-limit")
            return data

        def read(amt=None, *args, **kwargs):
            limit = 4 * 1024 * 1024 - received + 1
            return check(original_read(min(amt, limit) if amt is not None else limit, *args, **kwargs))

        def stream(amt=65536, decode_content=None):
            for part in original_stream(min(amt or 65536, 65536), decode_content):
                if raw.chunked:
                    check(part)
                yield part

        raw.read, raw.stream = read, stream
        return response

    requests.adapters.HTTPAdapter.send = send


def resolve(value):
    blocked = value.get("blockedDomains", [])
    url = public_url(value["url"], blocked)
    protect_network(blocked)
    logging.disable(logging.CRITICAL)
    from gallery_dl import config, extractor
    from gallery_dl.extractor.message import Message

    for key, item in {"timeout": 8, "retries": 0, "proxy-env": False, "cookies": None, "cookies-update": False}.items():
        config.set(("extractor",), key, item)
    config.set(("extractor", "ytdl"), "enabled", False)
    config.set(("cache",), "file", None)
    first = extractor.find(url)
    if first is None:
        return {"status": "unsupported", "media": []}
    media, visited = [], set()

    def collect(current, depth=0):
        if current.url in visited or len(visited) >= 4:
            return
        visited.add(current.url)
        try:
            for message in current:
                if len(media) >= 11:
                    break
                if message[0] == Message.Url:
                    target = public_url(message[1], blocked)
                    if any(item["url"] == target for item in media):
                        continue
                    headers = dict(current.session.headers)
                    headers.update(message[2].get("_http_headers") or {})
                    safe = {name: str(item) for name, item in headers.items()
                            if name.lower() in ("referer", "user-agent") and isinstance(item, str) and len(item) <= 4000 and "\r" not in item and "\n" not in item}
                    media.append({"url": target, "headers": safe})
                elif message[0] == Message.Queue and depth < 1:
                    child = extractor.find(public_url(message[1], blocked))
                    if child is not None:
                        collect(child, depth + 1)
        finally:
            if current.session:
                current.session.close()

    collect(first)
    return {"status": "ok" if media else "failed", "media": media}


if __name__ == "__main__":
    try:
        request = json.loads(sys.stdin.buffer.read(65537))
        result = resolve(request)
    except Exception:
        result = {"status": "failed", "media": []}
    print(json.dumps(result, ensure_ascii=True))
