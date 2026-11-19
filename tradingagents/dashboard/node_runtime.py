"""Install the frontend toolchain locally when the launcher has no supported Node.js."""

import errno
import hashlib
import platform
import shutil
import sys
import tarfile
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.request import urlopen

_VERSION = "24.22.3"
# SHA-256 from https://nodejs.org/dist/v24.22.3/SHASUMS256.txt.
_CHECKSUMS = {
    ("linux", "x64"): "061ec3e3062115705b56b51fa9cc330ab50d34b6969387d4e4b1a50c6809acc2",
    ("linux", "arm64"): "261af2af250dfd7e9f25cf151d1b2713a0adf8f10a9ad116c4947f68627affe8",
    ("darwin", "x64"): "977614af0504c81045e7fd85596dbca0e5f951b96681516dadafedcca8c447f7",
    ("darwin", "arm64"): "ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd",
}


def node_bin(cache_dir: Path) -> Path:
    system = platform.system().lower()
    machine = platform.machine().lower()
    arch = {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(machine)
    checksum = _CHECKSUMS.get((system, arch))
    if checksum is None:
        raise ValueError(f"No bundled download is available for {system} {machine}.")

    release = f"node-v{_VERSION}-{system}-{arch}"
    target = cache_dir / release
    if target.is_dir():
        return target / "bin"

    print(f"Downloading Node.js {_VERSION} and npm from nodejs.org…", file=sys.stderr, flush=True)
    with TemporaryDirectory(dir=cache_dir) as folder:
        staging = Path(folder)
        archive_path = staging / f"{release}.tar.gz"
        url = f"https://nodejs.org/dist/v{_VERSION}/{archive_path.name}"
        with urlopen(url, timeout=45) as response, archive_path.open("wb") as output:
            shutil.copyfileobj(response, output)
        with archive_path.open("rb") as archive:
            if hashlib.file_digest(archive, "sha256").hexdigest() != checksum:
                raise ValueError("The Node.js download failed its checksum verification.")

        with tarfile.open(archive_path) as archive:
            # The exact archive is verified above, including on older Python 3.11 builds.
            options = {"filter": "data"} if hasattr(tarfile, "data_filter") else {}
            archive.extractall(staging, **options)
        try:
            (staging / release).rename(target)
        except OSError as error:
            if error.errno not in (errno.EEXIST, errno.ENOTEMPTY) or not target.is_dir():
                raise

    return target / "bin"


if __name__ == "__main__":
    try:
        print(node_bin(Path(sys.argv[1])))
    except (OSError, tarfile.TarError, ValueError) as error:
        raise SystemExit(f"Could not set up Node.js. {error}\nInstall Node.js 24 LTS with npm and rerun ./run.sh.") from None
