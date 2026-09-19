# CLI 2.0.0 candidate validation

This branch is a release candidate, not an npm release. Node 24.21.0; runtime pins and official API sources are in COMPATIBILITY.md.

Passed: self-test; 10 protocol/permissions/usage/image mapping tests; tarball installation and version check. Actual Codex stream, reconnect/resume, cancellation and image inference; OpenClaw handshake, inference, two-turn memory and image inference; Hermes Responses, Runs streaming, deadline cancellation and image inference.

Blocking: Claude inference still reports Not logged in. Complete all four runtime permission, reconnect and accounting cases plus H2A/A2A/compatibility-API and billing end-to-end validation before merging/releasing. Do not interpret mocked tests as real runtime acceptance. No production runtime upgrade or npm publish has occurred.
