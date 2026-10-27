"""Update source installs from official GitHub releases using the standard library."""

from __future__ import annotations

import io
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.error
import urllib.request
from contextlib import contextmanager
from importlib import metadata
from pathlib import Path, PurePosixPath


VERSION = "0.1.4"
REPOSITORY = "https://github.com/FupaulHuang/EasyPlate"
RELEASE_API = "https://api.github.com/repos/FupaulHuang/EasyPlate/releases/latest"
FORMULA = "FupaulHuang/easyplate/easyplate"
SOURCE_FILES = frozenset({
    ".gitignore", "AGENTS.md", "LICENSE", "README.md", "app.js", "xlsx.js",
    "index.html", "server.py", "updater.py", "start.sh", "easyplate",
    "styles.css", "docs/easyplate-browser.png",
})
DOWNLOAD_LIMIT = 25 * 1024 * 1024


class UpdateError(Exception):
    """An update could not proceed without affecting the user's installation."""


def version_tuple(tag: str) -> tuple[int, int, int]:
    match = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)", tag)
    if not match:
        raise UpdateError("The release version is not supported by this updater.")
    return tuple(int(value) for value in match.groups())


def download(url: str, limit: int = DOWNLOAD_LIMIT) -> bytes:
    request = urllib.request.Request(url, headers={
        "User-Agent": "EasyPlate/" + VERSION,
        "Accept": "application/vnd.github+json" if url == RELEASE_API else "application/octet-stream",
    })
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            if not response.url.startswith("https://"):
                raise UpdateError("GitHub redirected the download to an insecure URL.")
            data = response.read(limit + 1)
    except urllib.error.HTTPError as error:
        if error.code in (403, 429):
            raise UpdateError("GitHub's request limit was reached. Try again later.") from error
        raise UpdateError("GitHub returned HTTP " + str(error.code) + ". No update was installed.") from error
    except (urllib.error.URLError, TimeoutError) as error:
        raise UpdateError("Could not reach GitHub. Check your connection and try again.") from error
    if len(data) > limit:
        raise UpdateError("The release download exceeds the supported size.")
    return data


def latest_release() -> str:
    try:
        release = json.loads(download(RELEASE_API, 1024 * 1024))
        if not isinstance(release, dict):
            raise ValueError()
        tag = release["tag_name"]
        if release.get("draft") or release.get("prerelease") or not isinstance(tag, str):
            raise ValueError()
        version_tuple(tag)
        return tag
    except (ValueError, TypeError, KeyError) as error:
        raise UpdateError("GitHub returned an invalid release response.") from error


def source_archive(tag: str) -> dict[str, tuple[bytes, int]]:
    version_tuple(tag)
    data = download(REPOSITORY + "/archive/refs/tags/" + tag + ".tar.gz")
    result = {}
    total = 0
    try:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
            for index, member in enumerate(archive):
                if index > 1000:
                    raise UpdateError("The archive contains too many entries.")
                parts = PurePosixPath(member.name).parts
                if not parts or ".." in parts or PurePosixPath(member.name).is_absolute():
                    raise UpdateError("Unsafe path in the source archive.")
                if member.isdir():
                    continue
                name = "/".join(parts[1:])
                if not member.isfile() or name not in SOURCE_FILES or name in result:
                    raise UpdateError("The release file list has changed. Install this release manually.")
                total += member.size
                if member.size < 0 or total > DOWNLOAD_LIMIT:
                    raise UpdateError("The expanded source archive is too large.")
                stream = archive.extractfile(member)
                content = stream.read(member.size + 1)
                if len(content) != member.size:
                    raise UpdateError("Incomplete source archive.")
                result[name] = (content, 0o755 if member.mode & 0o111 else 0o644)
    except (tarfile.TarError, EOFError) as error:
        raise UpdateError("The downloaded source archive is damaged.") from error
    if set(result) != SOURCE_FILES:
        raise UpdateError("The source archive is missing required files.")
    expected = ('VERSION = "' + tag.lstrip("v") + '"').encode()
    if expected not in result["updater.py"][0]:
        raise UpdateError("The downloaded source version does not match the release.")
    return result


def run(command: list[str], root: Path | None = None, capture: bool = False) -> str:
    process = subprocess.run(command, cwd=root, text=True, check=False,
                             stdout=subprocess.PIPE if capture else None,
                             stderr=subprocess.PIPE if capture else None)
    if process.returncode:
        detail = (process.stderr or "").strip() if capture else "See the command output above."
        raise UpdateError(command[0] + " failed. " + detail)
    return (process.stdout or "").strip()


def git_update(root: Path, tag: str) -> None:
    if shutil.which("git") is None:
        raise UpdateError("Install Git before updating this checkout.")
    if Path(run(["git", "rev-parse", "--show-toplevel"], root, True)).resolve() != root:
        raise UpdateError("This folder is not the root of its Git checkout.")
    origin = run(["git", "remote", "get-url", "origin"], root, True)
    if origin.rstrip("/") not in (REPOSITORY, REPOSITORY + ".git", "git@github.com:FupaulHuang/EasyPlate.git"):
        raise UpdateError("This checkout uses a different Git remote. Update it manually.")
    if run(["git", "status", "--porcelain", "--untracked-files=no"], root, True):
        raise UpdateError("Local code changes found. Commit or save them before updating.")
    run(["git", "fetch", "--no-tags", REPOSITORY + ".git", "refs/tags/" + tag], root)
    commit = run(["git", "rev-parse", "FETCH_HEAD^{commit}"], root, True)
    if subprocess.run(["git", "merge-base", "--is-ancestor", commit, "HEAD"], cwd=root).returncode == 0:
        print("This checkout already contains " + tag + " (it may include newer commits).")
        return
    if subprocess.run(["git", "merge-base", "--is-ancestor", "HEAD", commit], cwd=root).returncode != 0:
        raise UpdateError("Local history has diverged from the release. No reset or overwrite was performed.")
    if run(["git", "status", "--porcelain", "--untracked-files=no"], root, True):
        raise UpdateError("Local code changed during the download. Update cancelled.")
    run(["git", "-c", "merge.autostash=false", "merge", "--ff-only", "--no-edit", commit], root)
    print("Updated the checkout to " + tag + ".")


def safe_path(root: Path, name: str) -> Path:
    path = root / name
    for component in (path, *path.parents):
        if component == root:
            break
        if component.is_symlink():
            raise UpdateError("Refusing to replace a symbolic link: " + name)
    if path.exists() and not path.is_file():
        raise UpdateError("Expected a regular source file: " + name)
    return path


def replace_file(target: Path, content: bytes, mode: int) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".easyplate-write-", dir=target.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def recover_source(root: Path) -> None:
    journal = root / ".easyplate-update-pending"
    if not journal.exists():
        return
    safe_path(root, journal.name)
    name = journal.read_text().strip()
    if not re.fullmatch(r"\.easyplate-backup-[A-Za-z0-9_-]+", name):
        raise UpdateError("Invalid update recovery record; restore your source backup manually.")
    backup = root / name
    if backup.is_symlink() or not backup.is_dir():
        raise UpdateError("The update backup is missing.")
    manifest = json.loads(safe_path(backup, "manifest.json").read_text())
    if not isinstance(manifest, dict) or set(manifest) != SOURCE_FILES:
        raise UpdateError("Invalid source backup manifest.")
    for file_name, mode in manifest.items():
        destination = safe_path(root, file_name)
        source = safe_path(backup, file_name)
        replace_file(destination, source.read_bytes(), int(mode) & 0o777)
    journal.unlink()
    print("Restored the source files from an interrupted update.")


def archive_update(root: Path, tag: str) -> None:
    previous = source_archive("v" + VERSION)
    incoming = source_archive(tag)
    for name, (original, _) in previous.items():
        path = safe_path(root, name)
        if not path.is_file() or path.read_bytes() != original:
            raise UpdateError("Local code changes found in " + name + ". Save them before updating.")
    backup = Path(tempfile.mkdtemp(prefix=".easyplate-backup-", dir=root))
    manifest = {}
    for name in sorted(SOURCE_FILES):
        source = safe_path(root, name)
        destination = backup / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        manifest[name] = source.stat().st_mode & 0o777
    (backup / "manifest.json").write_text(json.dumps(manifest))
    for name, (original, _) in previous.items():
        if safe_path(root, name).read_bytes() != original:
            raise UpdateError("Source files changed while creating the backup. Update cancelled.")
    journal = safe_path(root, ".easyplate-update-pending")
    replace_file(journal, backup.name.encode(), 0o600)
    try:
        for name, (content, mode) in incoming.items():
            replace_file(safe_path(root, name), content, mode)
    except BaseException:
        recover_source(root)
        raise
    journal.unlink()
    print("Updated to " + tag + ". Previous source files: " + str(backup))


@contextmanager
def update_lock(root: Path):
    import fcntl
    path = safe_path(root, ".easyplate-update.lock")
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise UpdateError("Another EasyPlate update is already running.") from error
        yield


def homebrew_update(brew: str, tag: str) -> None:
    if not Path(brew).is_absolute() or not Path(brew).is_file():
        raise UpdateError("Homebrew could not be found. Run brew update and brew upgrade " + FORMULA + " manually.")
    run([brew, "update"])
    info = json.loads(run([brew, "info", "--json=v2", FORMULA], capture=True))
    formula = info["formulae"][0]
    if version_tuple(formula["versions"]["stable"]) < version_tuple(tag):
        raise UpdateError("GitHub has " + tag + ", but the Homebrew tap is not updated yet. Try again later.")
    run([brew, "upgrade", FORMULA])
    installed = run([brew, "list", "--versions", "easyplate"], capture=True).split()[1:]
    if not any(version_tuple(value.split("_")[0]) >= version_tuple(tag) for value in installed):
        raise UpdateError("Homebrew did not install the latest release. Check whether EasyPlate is pinned.")
    print("Homebrew has installed " + tag + " or newer.")


def update(root: Path, check_only: bool = False) -> int:
    try:
        root = root.resolve()
        if sys.platform not in ("linux", "darwin"):
            raise UpdateError("Use Microsoft Store updates on Windows. This updater supports Linux and macOS.")
        # Restore interrupted archive updates before downloading or executing more code.
        if (root / ".easyplate-update-pending").exists() and not check_only:
            with update_lock(root):
                recover_source(root)
            print("Run the update command again using the restored version.")
            return 1
        tag = latest_release()
        print("Installed: v" + VERSION + " | Latest GitHub release: " + tag)
        if version_tuple(tag) <= version_tuple(VERSION):
            print("EasyPlate is up to date.")
            return 0
        if check_only:
            print("An update is available. Run easyplate update to install it.")
            return 0
        marker = root / ".easyplate-homebrew"
        if marker.is_file():
            homebrew_update(marker.read_text().strip(), tag)
            return 0
        if getattr(sys, "frozen", False):
            raise UpdateError("Update this native installation with its installer, or use the source/Homebrew installation for easyplate update.")
        try:
            distribution = metadata.distribution("easyplate-local")
        except metadata.PackageNotFoundError:
            distribution = None
        if distribution and Path(distribution.locate_file("easyplate/server.py")).resolve() == root / "server.py":
            raise UpdateError("Update this wheel installation with pip and a newer wheel. GitHub releases provide source archives; use a source install for automatic updates.")
        print("Updating from the official EasyPlate repository...")
        with update_lock(root):
            if (root / ".git").exists():
                git_update(root, tag)
            else:
                archive_update(root, tag)
        print("Restart EasyPlate and refresh its browser tab to use the updated files.")
        return 0
    except (UpdateError, OSError, ValueError, KeyError, IndexError) as error:
        print("Update failed: " + str(error), file=sys.stderr)
        return 1
