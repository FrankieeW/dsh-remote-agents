# JavaScript contract reference

These pre-migration JavaScript backend implementations are retained solely as
regression oracles for the established protocol, validation and data contracts.
They are not imported by the production host or CLI and are not included in npm
packages. Their tests do not establish correctness of the Rust backend.

The new runtime is exercised separately by `test/native-backend.test.js`, Rust
unit tests, the actual packed-host/client test, and the native tmux smoke test.
