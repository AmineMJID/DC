#!/usr/bin/env python3
"""
DC Rack Planner — serveur minimal avec persistance JSON.

Il fait deux choses :
  1. Sert les fichiers statiques (index.html, app.js, styles.css, assets/...).
  2. Expose une mini-API pour sauvegarder / charger l'état de l'application
     dans un fichier JSON sur le disque : data/state.json.

Ainsi les workspaces (racks, devices, ports, câbles…) sont enregistrés
« à vie » côté serveur : ils ne disparaissent pas quand on change de
navigateur, d'ordinateur ou qu'on vide le cache du navigateur.

Lancement :
    python3 server.py            # http://localhost:8080
    python3 server.py 9000       # sur un autre port

Aucune dépendance externe (bibliothèque standard Python uniquement).
"""

import json
import os
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

# Répertoire de ce fichier (on sert depuis là où se trouve le script)
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
STATE_FILE = os.path.join(DATA_DIR, "state.json")

# Écriture sérialisée (plusieurs requêtes peuvent arriver en parallèle)
_lock = threading.Lock()

# Types MIME habituels (le module en connaît déjà beaucoup, on complète)
EXTRA_MIME = {
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".svg": "image/svg+xml",
    ".json": "application/json; charset=utf-8",
}


def load_state():
    """Lit l'état depuis le fichier JSON. Renvoie {} si absent/invalide."""
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}
    except (ValueError, OSError):
        # Fichier corrompu : on ne l'écrase pas, on repart à vide.
        return {}


def save_state(data):
    """Écrit l'état de façon atomique (fichier temporaire + renommage)."""
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = STATE_FILE + ".tmp"
    with _lock:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, STATE_FILE)  # remplacement atomique


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    def guess_type(self, path):
        for ext, mime in EXTRA_MIME.items():
            if path.endswith(ext):
                return mime
        return super().guess_type(path)

    def log_message(self, fmt, *args):
        # Logs discrets : une ligne par requête API/erreur seulement
        if "api/state" in (self.path or ""):
            super().log_message(fmt, *args)

    def _send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.split("?")[0] == "/api/state":
            self._send_json(load_state())
            return
        super().do_GET()

    def do_PUT(self):
        if self.path.split("?")[0] == "/api/state":
            try:
                length = int(self.headers.get("Content-Length", 0))
                raw = self.rfile.read(length) if length else b""
                data = json.loads(raw.decode("utf-8"))
                if not isinstance(data, dict):
                    raise ValueError("Le corps doit être un objet JSON")
            except (ValueError, UnicodeDecodeError) as e:
                self._send_json({"ok": False, "error": str(e)}, status=400)
                return
            try:
                save_state(data)
            except OSError as e:
                self._send_json({"ok": False, "error": str(e)}, status=500)
                return
            self._send_json({"ok": True})
            return
        self.send_error(404)

    # On ignore les favicons / méthodes non prévues
    def do_POST(self):
        self.send_error(405)


def main():
    port = 8080
    import sys
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            pass

    os.makedirs(DATA_DIR, exist_ok=True)
    if not os.path.exists(STATE_FILE):
        save_state({})

    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"DC Rack Planner — serveur démarré sur http://localhost:{port}")
    print(f"Sauvegarde des workspaces : {STATE_FILE}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nArrêt du serveur.")
        server.server_close()


if __name__ == "__main__":
    main()