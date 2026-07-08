# Silvio LETS software - overall plan

Silvio is a modern Web2.0 implementation of a Local Exchange Trading
System (LETS) which allow people to trade in a local area using a
closed virtual currency.  Inspired by Silvio Gesell and "Stamp Scrip"
is has the unusual property of 'demurrage' or a negative interest rate
on balances, to discourage hoarding and ensure economic velocity ("Bad
money drives out good").

In common with other LETS, negative balances are allowed and encouraged.  Credit
control is by social pressure.

## References

* [CamLETS](https://cam.letslink.org) - the author was one of the founders
* [Falmouth LETS](https://falmouthlets.uk/) - author's local LETS, developed...
* [Mutual Credit Manager](https://www.mutualcreditmanager.co.uk/)
* [Local Exchange UK](https://github.com/cdmweb/Local-Exchange-UK) legacy PHP software

See also:

* [first-review.md](first-review.md) - research review of the references and the
  wider mutual-credit software space, with gap analysis
* [decisions.md](decisions.md) - design decisions #1-#9 (demurrage, multi-tenancy,
  credit control, federation, transaction states, ledger, membership, reputation,
  MCP auth)

## Functions

* Maintain a list of members - name, address, email, phone; application/approval
  and leaving flows (decision #7); no membership fees - demurrage funds the
  community account
* Maintain a list of currencies - name, symbol, demurrage bands & other properties
* Maintain balances and transaction history for each member in one or more currencies
* Provide means of payment between members - date, amount, reference; also
  invoices/payment requests, with two-phase pending/committed states (decision #5)
* Provide a 'marketplace' of categorised wants and offers, with search
* Pluggable credit control - soft threshold flags, optional hard limits, manual
  restriction (decision #3)
* Management operations:
  * Dashboard statistics/graphs of balance distribution, currency flow over time, ...
  * Monthly demurrage posting to a community account (marginal bands; decision #1)
  * Audit - balances sum to zero (zero-sum by construction; decision #6)
  * Suspend or remove members; audit log of admin actions
* Email notifications and offers/wants digests
* MCP server - query marketplace and users, make payments (scoped tokens,
  human-confirmed payments by default; decision #9)

## Architecture

React/Vite/TypeScript/MUI on the front end, TypeScript/Node on the back end.  Later option to wrap web front end as an Android/IOS app.

API-first: one REST API serving the web UI, MCP server and future mobile wrapper.

Multi-tenant from the start (decision #2) - one instance hosts many groups;
white-label SaaS is a target deployment model.  Design goal: thousands of members
across groups on a minimal VPS.

Ledger: normalised append-only double-entry journal; multi-currency transactions
with per-currency zero-sum legs; balances are derived quantities (decision #6).

Pluggable storage interface - SQLite as first implementation; balance
caching/derivation is the storage layer's private decision.

Inter-LETS federation (gateway accounts, Credit Commons) designed for but not
implemented (decision #4).

Payment:  Mobile-friendly, EPOS-style - QR code provides payee ID, amount and
suggested reference, payer scans and authorises.

Authentication:  Standard username/password with 2FA/passkey support.
