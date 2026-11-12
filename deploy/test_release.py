import tempfile
import unittest
from pathlib import Path
from release import release_files

class ReleaseTests(unittest.TestCase):
    def test_source_archive_excludes_credentials_and_runtime_data(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            for name in ['README.md','AGENTS.md','.dockerignore','.gitignore']:(root/name).write_text('source')
            for name in ['dsh-workbench','spec-analyst-preset','stage-presets','deploy']:(root/name).mkdir()
            for name in ['client.js','.env','server.key','debug.log','node_modules/a.js','.dsh/secret.json']:
                path=root/'dsh-workbench'/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text('example')
            paths={str(p.relative_to(root)) for p in release_files(root)}
            self.assertIn('dsh-workbench/client.js',paths)
            self.assertFalse(any('secret' in p or p.endswith(('.env','.key','.log')) or 'node_modules' in p for p in paths))

    def test_source_archive_rejects_unexpected_symlinks(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            for name in ['dsh-workbench','spec-analyst-preset','stage-presets','deploy']:(root/name).mkdir()
            (root/'dsh-workbench/external.txt').symlink_to('/etc/hosts')
            with self.assertRaises(ValueError):release_files(root)
