# Rabbit POS

Bar & restaurant till for Rabbit Tree. It runs on the reception PC; tablets and phones open it in the browser over the wifi.
Bills put on a guest go to the Reception Google Sheet as *Unpaid* and are paid at the reception (Guest bills in Rabbit-System).

## Start
1. Install Node.js 22 LTS (nodejs.org) on the reception PC.
2. Double-click `start.bat` (or `npm start`). The window shows the address to open on the tablets.
3. First start creates the owner with PIN **1234**: change it.

Try it with demo data: `npm run demo` (PINs: owner 1234, manager 1111, waiter 2222, reception 3333, cashier 4444).

## Google Sheet
Set up once: see `bridge/README.md`. Options from the command line: `npm run config`.

## Tests
`npm test`

Data lives in `data/pos.db` (back it up). No internet needed to sell; the Sheet is updated when the connection is back.
