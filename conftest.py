import os
import sys

# Append project root to sys.path so backend submodules (database, sandbox, services, etc.)
# can be imported directly in tests without overriding external packages like the openalgo SDK.
project_root = os.path.dirname(os.path.abspath(__file__))
if project_root not in sys.path:
    sys.path.append(project_root)
