SMARTPY 0.25.3 PRIMER (every construct below was compiled or run with this exact toolchain; SmartPy is Python-LOOKING, not Python)

You write ONLY the statements of one function body. Already generated for you: the module, the class, the storage declaration, every entrypoint/view signature with typed parameters, the helper methods listed in the prompt, the "initialized" and "non-payable" checks, and the test scenario. Do not write `def`, decorators, `import`, `class`, or a `return` in an entrypoint.

Checks and control flow
- Revert: `assert cond, "MESSAGE"` or `raise "MESSAGE"` (use the Solidity revert text). There is NO `require`, NO `sp.failwith`, NO `sp.verify`, NO try/except. Any failure reverts the whole transaction.
- `if cond:` / `else:` ONLY. There is NO `elif`: write `else:` and a nested `if`. A ternary `a if cond else b` works. Use `and`, `or`, `not` (not `&&`, `||`, `!`).
- Loops: `for i in sp.range(0, n):`, `for x in xs:` (xs is a list parameter), `while cond:`. Keep loops short (gas).
- Local variables: plain `x = expr`, and `x = x + 1` or `x += 1` later. NO type annotations (`x: sp.nat = 0` is a syntax error).
- SCOPE: a variable first assigned INSIDE an if/else/for block does not exist after the block ("x is not defined"). Declare it before the block, then assign inside: `t = 0` / `if c:` / `    t = a` / `else:` / `    t = b` / then use `t`.
- RETURN: an entrypoint or `initialize` has no `return` at all (to skip the rest, put the remaining statements in an `else:`). A view's `return` must be its LAST statement, or the last statement of BOTH branches of a final if/else; there is NO early return (`if c: return 0` followed by more code does not compile). Compute into a local declared before the `if` and `return` it at the end.
- No f-strings, lambdas, comprehensions, `print`, imports, casts like `uint256(x)`, `address(x)`, `str(x)`, `int(x)`, floating point.

Numbers (the most common source of errors)
- Solidity uint -> `sp.nat` (never negative, any size). int -> `sp.int`. Literals: write `5`; to force a type `sp.nat(5)` / `sp.int(-5)` (ONLY with a literal inside: `sp.nat(x)` is an error).
- `a + b`, `a * b` of nats are nats. `a - b` of two nats is an INT. Therefore every subtraction that is stored in a nat or compared as a nat must be `sp.as_nat(a - b, error="MESSAGE")` (aborts with the message if negative: this is the Solidity 0.8 underflow revert). Comparisons `a >= b` are fine directly. `self.data.x -= y` on a nat is a type error: write `self.data.x = sp.as_nat(self.data.x - y, error="UNDERFLOW")`.
- `sp.as_nat(x)` ONLY accepts an int: use it around a subtraction or `sp.to_int(..)`, never around `a + b` or any value that is already a nat (that is a compile error).
- Convert: `sp.to_int(n)` (nat -> int), `sp.as_nat(i)` (int -> nat, aborts if negative), `abs(i)` (int -> nat).
- `/` is floor division on nats and ints, `%` is modulo (there is no `sp.mod` / `sp.div`). There is NO `**` and NO `//`. Power: `pow_nat((base, exponent))` (nats). `sp.min(a, b)`, `sp.max(a, b)` exist.
- Overflow: nats never overflow. If the Solidity code computes with uint256 and a result above 2^256-1 must revert, wrap it: `u256(a * b)`.

Storage
- Scalar state variables: `self.data.name` (read) and `self.data.name = value` (write). Only the fields listed in the prompt exist; any other `self.data.x` is an error.
- Mappings and arrays: READ with the generated helper `self.get_<name>(key)` (a missing key gives the Solidity default: 0, False, zero address); WRITE with `self.data.<name>[key] = value`; delete with `del self.data.<name>[key]` (never `del self.get_x(k)`). NEVER read with `self.data.<name>[key]` (a missing key aborts) and never `.get(...)`. Helpers take exactly ONE argument: for nested mappings pass a tuple, `self.get_allowance((owner, spender))` and `self.data.allowance[(owner, spender)] = v`.
- Struct values are records: `u = self.get_users(a)`, `u.amount += v`, `self.data.users[a] = u` (the local copy must be written back). Build one with `sp.record(a=1, b=x)`; read fields with `.a`.
- Dynamic arrays: length `self.data.<name>_len`, element `self.get_<name>(i)` (aborts if out of bounds), `self.push_<name>(v)`, `self.pop_<name>()`.
- Never touch `self.data.deployer` or `self.data.initialized`.

Context
- Caller: `sp.sender`. This contract: `sp.self_address`. Zero address: `ZERO_ADDRESS`. Time: `self.now_secs()` (nat seconds). Attached native value: `self.msg_value()` (nat). Own balance: `self.native_balance()`. Send native value: `self.send_native(sp.record(to=addr, amount=n))`.
- Do not compare an address with a string literal.
- Events: `sp.emit(sp.record(field=value, ...), tag="EventName")` with exactly the fields listed in the prompt.
- Calling another contract (ERC-20 token): ONLY through the listed helpers (`self.erc20_transfer(sp.record(token=..., to=..., amount=...))` etc.). Such calls are QUEUED and run after your entrypoint returns, in order; you cannot read their result in the same entrypoint (no balanceOf of another contract). Update your own state before queueing them.
- Strings: `sp.concat([a, b])`, `sp.len(s)`. A number as text: `string_utils.from_int(sp.to_int(n))` (Solidity `Strings.toString(n)`). Lists: `for x in xs`, `sp.len(xs)`.
- Views (`view_*`): finish with `return value`. They cannot read `sp.sender`, `sp.amount` or send operations. Several return values: `return sp.record(<exact field names listed in the prompt>)`.
- Entrypoints and `initialize` return nothing: drop Solidity return values.

Things that do NOT exist (each one was a real compile failure): early `return`, `return` in an entrypoint, variables kept after the block that first assigned them, `elif`, `**`, `//`, `x: T = v`, `sp.failwith`, `require`, `sp.nat(x)` of a variable, `sp.big_map(...)` with arguments inside a body, `self.data.m.get(k)`, `self.data.m[k] += 1`, a helper called with two arguments, an entrypoint calling another entrypoint (inline its logic), a plain Python helper method.

- Empty bytes are `sp.bytes("0x")`. `sp.bytes("")` is an empty SExpr atom and the compiler rejects it; user-defined value types such as `ShortString` are plain `sp.bytes` (bytes32) state, never an unsupported field.
