"""python -m autoclipper api|worker|all"""
import sys
import threading


def main():
    cmd = (sys.argv[1:] or ["all"])[0]
    if cmd == "api":
        from .api import main as api
        api()
    elif cmd == "worker":
        from .worker import main as worker
        worker()
    elif cmd == "all":  # one small machine: API + worker in one process
        from .worker import main as worker
        threading.Thread(target=worker, daemon=True).start()
        from .api import main as api
        api()
    else:
        print(__doc__)
        sys.exit(2)


if __name__ == "__main__":
    main()
