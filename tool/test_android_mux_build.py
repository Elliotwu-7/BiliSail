"""Exercise Android cross-compile arguments without an NDK or FFmpeg compile."""

import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class AndroidMuxBuildTests(unittest.TestCase):
    def test_android_cross_compile_targets(self):
        for target, arch, triple in [
            ("android-arm64", "aarch64", "aarch64-linux-android24"),
            ("android-x86_64", "x86_64", "x86_64-linux-android24"),
        ]:
            with self.subTest(target=target), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp) / "repo with spaces"
                package = root / "packages/bili_mux"
                (package / "tool").mkdir(parents=True)
                (package / "native").mkdir()
                cache = root / "build/download_mux"
                source = cache / "source"
                source.mkdir(parents=True)
                archive = b"local fixture archive; no network access"
                (cache / "n9.0.2.tar.gz").write_bytes(archive)
                script = (ROOT / "packages/bili_mux/tool/build.sh").read_text()
                # Only replace the source fixture digest, keeping the build
                # logic and source-hash verification intact.
                script = script.replace(
                    "archive_sha=6e374ed621e48faa40639307dff48ba6fe574a509977956d2cce9669b7cc27e9",
                    "archive_sha=" + hashlib.sha256(archive).hexdigest(),
                )
                build = package / "tool/build.sh"
                build.write_text(script)
                (source / "COPYING.LGPLv2.1").write_text("fixture license")
                self.executable(source / "configure", """#!/usr/bin/env python3
import json, os, pathlib, sys
pathlib.Path(os.environ['MUX_CONFIG_ARGS']).write_text(json.dumps(sys.argv[1:]))
pathlib.Path('ffbuild').mkdir(exist_ok=True)
pathlib.Path('ffbuild/config.mak').write_text('EXTRALIBS-avformat=\\n')
""")
                # NDK still calls the macOS host directory darwin-x86_64 on
                # Apple Silicon; match the production host-name convention.
                host = "darwin-x86_64" if platform.system() == "Darwin" else "linux-x86_64"
                ndk = Path(tmp) / "ndk"
                binaries = ndk / "toolchains/llvm/prebuilt" / host / "bin"
                binaries.mkdir(parents=True)
                self.executable(binaries / "make", "#!/usr/bin/env bash\nexit 0\n")
                self.executable(binaries / "llvm-strip", "#!/usr/bin/env bash\nexit 0\n")
                self.executable(binaries / "clang++", """#!/usr/bin/env python3
import json, os, pathlib, sys
pathlib.Path(os.environ['MUX_LINK_ARGS']).write_text(json.dumps(sys.argv[1:]))
pathlib.Path(sys.argv[sys.argv.index('-o') + 1]).write_text('fixture binary')
""")
                config_args = Path(tmp) / "config.json"
                link_args = Path(tmp) / "link.json"
                env = dict(os.environ, ANDROID_NDK_HOME=str(ndk),
                           MUX_CONFIG_ARGS=str(config_args), MUX_LINK_ARGS=str(link_args))
                subprocess.run(["bash", str(build), target], env=env,
                               check=True, capture_output=True, text=True)
                config = json.loads(config_args.read_text())
                link = json.loads(link_args.read_text())
                self.assertIn("--arch=" + arch, config)
                self.assertIn("--target-os=android", config)
                self.assertIn("--enable-cross-compile", config)
                self.assertIn("--disable-network", config)
                self.assertIn("--disable-x86asm", config)
                self.assertIn("--disable-jni", config)
                for flag in ["--extra-cflags=", "--extra-ldflags="]:
                    value = next(x for x in config if x.startswith(flag + "--target="))
                    self.assertIn("--target=" + triple, value)
                self.assertIn("--target=" + triple, link)
                self.assertIn("-Wl,-z,max-page-size=16384", link)
                output = package / "native/prebuilt" / target
                self.assertEqual((output / "libbili_mux.so").read_text(), "fixture binary")
                for name in ["source.txt", "configure.log", "COPYING.LGPLv2.1"]:
                    self.assertTrue((output / name).is_file(), name)

    @staticmethod
    def executable(path, content):
        path.write_text(content)
        path.chmod(0o755)


if __name__ == "__main__":
    unittest.main()
