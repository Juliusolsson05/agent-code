# Fixtures

Small, redacted fixtures live here when a test case is shared by multiple
modules or is too large to keep inline.

Prefer fixture builders in `testing/support/builders/` for ordinary object
setup. Use committed fixtures only when the literal shape matters, such as a
provider transcript edge case or a reduced debug bundle.

