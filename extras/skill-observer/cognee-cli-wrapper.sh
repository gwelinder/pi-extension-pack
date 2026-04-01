#!/usr/bin/env bash
# Wrapper that applies the mistralai shim before running cognee-cli
python3 -c "
import sys
try:
    import mistralai
    if not hasattr(mistralai, 'Mistral'):
        from mistralai.client import Mistral as _M
        mistralai.Mistral = _M
except: pass
from cognee.cli._cognee import main
sys.exit(main())
" "$@"
