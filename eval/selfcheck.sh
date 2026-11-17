# selfcheck.sh <TaskDir> <TaskId>: score the starter code, then the reference solution.
# A reference may list paths to delete (one per line) in ref/<TaskId>/.delete.
set -e
T=$(mktemp -d); cp -r tasks/$1/. $T/; echo "starter: $(node score.mjs $T $2 | cut -c1-200)"
cp -r ref/$2/. $T/
if [ -f ref/$2/.delete ]; then while read -r p; do [ -n "$p" ] && rm -rf "$T/$p"; done < ref/$2/.delete; rm -f $T/.delete; fi
echo "ref:     $(node score.mjs $T $2 | cut -c1-300)"
(cd $T && npm test >/dev/null 2>&1 && echo "visible on ref: pass" || echo "visible on ref: FAIL"); rm -rf $T
