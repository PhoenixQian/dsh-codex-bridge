// Community runtime: Python is optional and configured explicitly.
import {getPythonConfig} from '../runtime-config.mjs';
export const CONDA_PREFIX = getPythonConfig({agent:'Codex'}).prefix;
export const PYTHON_EXECUTABLE = getPythonConfig({agent:'Codex'}).executable;
export const DSH_CONDA_PREFIX = getPythonConfig({agent:'DSH'}).prefix;
