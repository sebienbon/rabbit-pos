// Demo menu, staff and guests for trying the POS (npm run demo). Real data comes later from the Loyverse export.
import { createUser } from './auth.js';
import { replaceGuests } from './orders.js';

export function seedDemo(db) {
  if (db.prepare('SELECT 1 FROM categories').get()) return;
  const cat = db.prepare('INSERT INTO categories (name, station, color, sort) VALUES (?, ?, ?, ?)');
  const prod = db.prepare('INSERT INTO products (category_id, name, price, sort) VALUES (?, ?, ?, ?)');
  const menu = [
    ['Coffee', 'bar', 'orange', [['Espresso', 25000], ['Cappuccino', 35000], ['Iced latte', 38000]]],
    ['Juices & smoothies', 'bar', 'teal', [['Avocado juice', 32000], ['Smoothie bowl', 55000]]],
    ['Beer & drinks', 'bar', 'sky', [['Bintang', 40000], ['Mojito', 85000], ['Arak attack', 75000]]],
    ['Food', 'kitchen', 'coral', [['Nasi goreng', 55000], ['Mie goreng', 50000], ['Burger', 85000]]],
    ['Desserts', 'kitchen', 'violet', [['Pisang goreng', 30000]]],
  ];
  menu.forEach(([name, station, color, items], i) => {
    const c = Number(cat.run(name, station, color, i).lastInsertRowid);
    items.forEach(([n, p], j) => prod.run(c, n, p, j));
  });
  for (const [name, role, pin] of [['Ayu', 'manager', '1111'], ['Wayan', 'waiter', '2222'], ['Putu', 'reception', '3333'], ['Komang', 'cashier', '4444']])
    createUser(db, { name, role, pin });
  replaceGuests(db, ['Martin Dupont', 'Mariana Silva', 'Jonas Keller', 'Hiro Tanaka'].map((name, i) => ({ name, room: String([12, 3, 8, 15][i]) })));
  console.log('Demo data added: PINs owner 1234, manager 1111, waiter 2222, reception 3333, cashier 4444');
}
