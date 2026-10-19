# Owned local signal cleanup

Normal root gate attempt 2 passed docs/build and corrected packed-consumer tests, then failed the playtest orphan fixture. Known persistent coordination infrastructure was originally counted as growth. Initializing it before the count baseline and adding explicit empty lease/queue checks then exposed a genuine forced-SIGTERM leak: `lock/holder.json` survived. Both failures are retained.

The local runner now shares one idempotent resource release between signal teardown and normal/error finally. It awaits this run's in-flight display/lease acquisition and calls only their existing exact-owner release handles, after browser/server cleanup, before the unchanged interrupted exit code 2. Startup guards prevent a later URL/preparation await from spawning an owned server/browser after teardown. The mutex protocol and timeout policy are unchanged; no other owner is removed.

Final real forced/unforced SIGTERM gates both pass with process, directory, lock and queue assertions intact. Existing runner/suite plus pending-acquisition, second-cleanup, release-error and real replacement-holder tests: 226 pass. Runner build/publint pass. Independent review confirms local lifecycle guards and owner release, while identifying an unresolved pre-existing borrowed remote-browser edge: an in-flight newPage/remote preparation may finish after remote teardown. This repair does not claim complete remote cancellation qualification, and does not close a borrowed user browser/context.

The complete normal root suite still requires a passing rerun; its unit phase was not reached in the retained failed run. No original visual or native acceptance gate is waived.
