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

## Functions

* Maintain a list of members - name, address, email, phone
* Maintain a list of currencies - name, symbol, demurrage & other properties
* Maintain balances and transaction history for each member in one or more currencies
* Provide means of payment between members - date, amount, reference
* Provide a 'marketplace' of categorised wants and offers, with search
* Management operations:
  * Dashboard statistics/graphs of balance distribution, currency flow over time, ...
  * Sweep accounts for demurrage fees to a community account
  * Audit - balances sum to zero.
  * Suspend or remove members
* MCP server - query marketplace and users, make payments

## Architecture

React/Vite/TypeScript/MUI on the front end, TypeScript/Node on the back end.  Later option to wrap web front end as an Android/IOS app.

Pluggable storage interface - SQLite as first implementation.

Payment:  Mobile-friendly, EPOS-style - QR code provides payee ID, amount and
suggested reference, payer scans and authorises.

Authentication:  Standard username/password with 2FA/passkey support.
