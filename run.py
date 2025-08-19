import uvicorn
import webbrowser
import threading
import time

def _open_browser(url: str):
	time.sleep(0.7)
	try:
		webbrowser.open(url)
	except Exception:
		pass 

if __name__ == "__main__":
	url = "http://127.0.0.1:8000"

	threading.Thread(target=_open_browser, args=(url,), daemon=True).start()

	uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True)