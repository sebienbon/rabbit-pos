/**
 * Rabbit POS — stock & purchasing data in the Google Sheet "Accounting Processor 2026".
 * Second file of the same Apps Script project "POS" as journal.gs (same deployment, same address, same SECRET).
 * journal.gs's doPost sends every request that has an `action` here.
 *
 * Rules, so any script or AI can use these tabs:
 *   one tab per kind of thing, one row per thing, English headers on row 1, a fixed `id` in column A.
 *   Lists made of several ids are written "a, b, c". Existing tabs (Historic, Arya, Feed…) are never touched.
 *
 * Setup (once): paste this file next to journal.gs › choose setupStock in the menu › Run › accept.
 * Then Deploy › Manage deployments › Edit › Version: New version › Deploy (the address stays the same).
 */
var STOCK_SHEET_ID = '1PjmpkYGyVunY9JvQvRqqcq9tpW-H3w662WXcfY6AV4g'; // "Accounting Processor 2026" (not a secret: it is private)

// The tabs, their columns, in order. Adding a column at the END later is safe; never rename or move one.
var STOCK_TABS = {
  // Settings the owner/manager change
  Categories:    ['id', 'label_fr', 'label_en', 'order'],
  Locations:     ['id', 'label', 'order'],
  PurchaseModes: ['id', 'label', 'hint', 'excludes', 'order'],
  Units:         ['id', 'family', 'to_base', 'base', 'label'],
  // What we use, and what we buy
  Ingredients:   ['id', 'name', 'name_en', 'name_fr', 'category', 'stock_unit', 'purchase_modes', 'locations',
                  'preferred_products', 'note', 'active', 'updated_at'],
  Products:      ['id', 'name', 'ingredient_id', 'pack_count', 'pack_qty', 'pack_unit', 'base_qty', 'base_unit',
                  'last_price', 'price_per_base', 'preference', 'note', 'active', 'updated_at'],
  // Order → receipt → monthly bill
  Orders:        ['id', 'date', 'by', 'status', 'note', 'updated_at'],
  OrderLines:    ['id', 'order_id', 'ingredient_id', 'qty', 'unit', 'preferred_product', 'note'],
  Receipts:      ['id', 'date', 'order_id', 'by', 'note', 'updated_at'],
  ReceiptLines:  ['id', 'receipt_id', 'order_line_id', 'ingredient_id', 'status', 'product_id', 'count', 'base_qty',
                  'note', 'bill_line_id'],
  BillLines:     ['id', 'bill_ref', 'date', 'supplier', 'text', 'qty', 'amount', 'product_id', 'receipt_line_id',
                  'match', 'note'],
  Prices:        ['id', 'date', 'product_id', 'price', 'source']
};
// ReceiptLines.status: received | different | missing | extra.  BillLines.match: auto | checked | to_check | none.

var STOCK_SEED = {
  Categories: [['legume', 'Légumes', 'Vegetables', 1], ['fruit', 'Fruits', 'Fruit', 2], ['protine', 'Viandes et protéines', 'Meat & protein', 3],
    ['laitier', 'Produits laitiers', 'Dairy', 4], ['feculent', 'Féculents', 'Starch', 5], ['sauce', 'Sauces et huiles', 'Sauces & oils', 6],
    ['aromate', 'Épices et aromates', 'Spices & herbs', 7], ['sucrerie', 'Sucré', 'Sweet', 8], ['snack', 'Snacks', 'Snacks', 9],
    ['boisson', 'Boissons', 'Drinks', 10], ['menage', 'Ménage et entretien', 'Cleaning', 11]],
  Locations: [['gudang-atas', 'Gudang Atas', 1], ['gudang-bawah', 'Gudang Bawah', 2], ['kitchen', 'Kitchen', 3], ['bar', 'Bar', 4],
    ['laundry', 'Laundry', 5]],
  PurchaseModes: [['A', 'Avec Aria', 'Le staff peut le commander à Aria quand il en a besoin.', 'U', 1],
    ['U', 'Si urgent', 'Aria seulement en dépannage.', 'A', 2],
    ['N', 'Internet', 'Stock acheté en ligne par le manager pour réduire les frais.', '', 3],
    ['X', 'Autre', 'Cas particulier : préciser dans le commentaire.', '', 4]],
  Units: [['g', 'weight', 1, 'g', 'gram'], ['kg', 'weight', 1000, 'g', 'kilo'], ['ml', 'volume', 1, 'ml', 'millilitre'],
    ['cl', 'volume', 10, 'ml', 'centilitre'], ['L', 'volume', 1000, 'ml', 'litre'], ['pcs', 'piece', 1, 'pcs', 'piece'],
    ['pack', 'piece', 1, 'pcs', 'pack (contents unknown)'], ['box', 'piece', 1, 'pcs', 'box (contents unknown)']],
  // Ingredients reviewed by the owner on 07/11/2026 (+ 7 new ones from the price list, to confirm)
  Ingredients: [
    ["aluminium-foil", "aluminium foil", "aluminium foil", "papier alu", "menage", "", "A, N", "kitchen", "", "", true],
    ["ayam-fillet", "ayam fillet", "chicken fillet", "filet de poulet", "protine", "", "A", "kitchen", "", "", true],
    ["balsamic-vinegar", "balsamic vinegar", "balsamic vinegar", "vinaigre balsamique", "sauce", "", "A, N", "kitchen", "", "", true],
    ["bawang-bombay", "bawang bombay", "onions", "gros oignon", "legume", "", "A", "kitchen", "", "", true],
    ["bawang-merah", "bawang merah", "shallots", "échalote", "legume", "", "A", "kitchen", "", "", true],
    ["bawang-putih", "bawang putih", "garlic", "ail", "legume", "", "A", "kitchen", "", "", true],
    ["bayclin", "bayclin", "bleach (Bayclin)", "javel Bayclin", "menage", "", "A", "gudang-atas, gudang-bawah", "", "", true],
    ["baygon", "baygon refill", "Baygon insecticide refills", "recharges d'insecticide Baygon", "menage", "", "A, N", "gudang-atas, gudang-bawah", "", "", true],
    ["beng-beng", "beng beng", "Beng-Beng chocolate bar", "barre chocolat Beng-Beng", "sucrerie", "", "A", "kitchen", "", "", true],
    ["beras", "beras", "rice", "riz (marques Selera/Royal/Pandawa)", "feculent", "", "A", "kitchen", "", "", true],
    ["buah-naga", "buah naga", "dragon fruit", "fruit du dragon", "fruit", "", "A", "bar", "", "", true],
    ["cola", "cola", "Coca-Cola", "Coca-Cola", "boisson", "", "A", "bar", "", "", true],
    ["daging-cincang", "daging cincang", "minced beef", "boeuf haché", "protine", "", "A", "kitchen", "", "", true],
    ["daun-mint", "daun mint", "mint", "menthe", "legume", "", "A", "bar", "", "", true],
    ["daun-seledri", "daun seledri", "celery leaves", "céleri", "legume", "", "A", "kitchen", "", "", true],
    ["es-batu", "es batu", "ice", "glace", "menage", "", "", "", "", "", true],
    ["feta-cheese", "feta cheese", "feta cheese", "féta (écrit « Veta CIS », « Peta cheese »)", "laitier", "", "A", "kitchen", "", "", true],
    ["french-fries", "french fries", "frozen French fries", "frites surgelées", "protine", "", "A", "kitchen, bar", "", "", true],
    ["garam", "garam", "salt", "sel (Dolpin / Refina)", "aromate", "", "A", "kitchen", "", "", true],
    ["gelas-plastik", "gelas plastik", "plastic cups", "gobelets / cup plastik", "menage", "", "A", "bar, gudang-atas", "", "", true],
    ["glass-cleaner", "glass cleaner", "glass cleaner", "nettoyeur vitre (Cling / Best Cling)", "menage", "", "A, N", "gudang-atas, gudang-bawah, bar", "", "", true],
    ["granola", "granola", "granola / muesli", "granola / muesli", "sucrerie", "", "A, N", "", "", "", true],
    ["gula-merah", "gula merah", "palm sugar", "sucre de palme", "aromate", "", "A", "kitchen", "", "", true],
    ["gula", "gula", "sugar", "sucre", "aromate", "", "A", "kitchen", "", "", true],
    ["isen", "isen", "to confirm (local spice root)", "à confirmer (mot local, souvent avec jae/kunyit)", "aromate", "", "A", "kitchen", "", "", true],
    ["jagung", "jagung", "corn", "maïs", "legume", "", "A", "kitchen", "", "", true],
    ["jahe", "jahe", "ginger", "gingembre (dit « jae »)", "aromate", "", "A", "kitchen", "", "", true],
    ["jeruk-manis", "jeruk manis", "sweet oranges", "orange douce", "fruit", "", "A", "bar", "", "", true],
    ["jeruk-nipis", "jeruk nipis", "lime", "citron vert", "aromate", "", "A", "kitchen", "", "", true],
    ["jeruk-non-precise", "jeruk non precise", "citrus (type not specified)", "agrume, variété non précisée", "aromate", "", "", "", "", "", true],
    ["kacang-panjang", "kacang panjang", "long beans", "haricots longs", "legume", "", "A", "kitchen", "", "", true],
    ["kangkung", "kangkung", "water spinach", "épinard d'eau", "legume", "", "A", "kitchen", "", "", true],
    ["kantung-belanja", "kantung belanja", "shopping bags", "sacs à courses", "menage", "", "", "", "", "", true],
    ["kecap-manis", "kecap manis", "sweet soy sauce", "sauce soja sucrée", "sauce", "", "A", "kitchen", "", "", true],
    ["keju-mozzarella", "keju mozzarella", "mozzarella", "mozzarella (Morzella / Muzalera / Mozarella Chess)", "laitier", "", "A", "kitchen", "", "", true],
    ["kemiri", "kemiri", "candlenuts", "noix de bougie", "aromate", "", "", "", "", "", true],
    ["kencur", "kencur", "kencur (aromatic ginger)", "kencur", "aromate", "", "A", "kitchen", "", "", true],
    ["kentang", "kentang", "potatoes", "pomme de terre (dit « jepang »)", "feculent", "", "A", "kitchen", "", "", true],
    ["kerupuk-udang", "kerupuk udang", "prawn crackers", "galettes de crevettes", "snack", "", "A", "kitchen", "", "", true],
    ["kol", "kol", "cabbage", "chou", "legume", "", "A", "kitchen", "", "", true],
    ["kopi", "kopi", "coffee", "café (555 / Kapal Api / mix)", "boisson", "", "A", "bar", "", "", true],
    ["kunyit", "kunyit", "turmeric", "curcuma", "aromate", "", "A", "kitchen", "", "", true],
    ["labu-siam", "labu siam", "chayote", "chayote", "legume", "", "A", "kitchen", "", "", true],
    ["lada-bubuk", "lada bubuk", "ground pepper", "poivre moulu", "aromate", "", "A", "kitchen", "", "", true],
    ["lengkuas", "lengkuas", "galangal", "galanga", "aromate", "", "A", "kitchen", "", "", true],
    ["madu", "madu", "honey", "miel", "sucrerie", "", "A, N", "kitchen", "", "", true],
    ["makanan-kucing", "makanan kucing", "cat food", "nourriture pour chats", "menage", "", "A, N", "gudang-atas", "", "", true],
    ["masako", "masako", "Masako seasoning", "cube/assaisonnement Masako", "aromate", "", "A", "kitchen", "", "", true],
    ["mayones", "mayones", "mayonnaise", "mayonnaise", "sauce", "", "A", "kitchen", "", "", true],
    ["micin", "micin", "MSG", "glutamate (Mesin / Micin)", "aromate", "", "A", "kitchen", "", "", true],
    ["minyak-goreng", "minyak goreng Bimoli", "frying oil Bimoli", "huile de friture (Bimoli/SunCoast)", "sauce", "", "A", "kitchen", "", "", true],
    ["molto", "molto", "fabric softener (Molto)", "adoucissant Molto", "menage", "", "A", "laundry, gudang-atas, gudang-bawah", "", "", true],
    ["mustard-dijon", "mustard dijon", "Dijon mustard", "moutarde de Dijon (Vilux)", "sauce", "", "A", "kitchen", "", "", true],
    ["nanas", "nanas", "pineapple", "ananas", "fruit", "", "A", "bar", "", "", true],
    ["nutella", "nutella", "Nutella (chocolate spread)", "pâte à tartiner", "sucrerie", "", "A, N", "kitchen", "", "", true],
    ["olive-oil", "olive oil", "olive oil", "huile d'olive (Mueloliva/Bertolli)", "sauce", "", "A", "kitchen", "", "", true],
    ["oregano", "oregano", "dried oregano", "origan séché", "aromate", "", "A, N", "kitchen", "", "", true],
    ["pepaya", "pepaya", "papaya", "papaye", "fruit", "", "A", "bar", "", "", true],
    ["pisang", "pisang", "bananas", "banane", "fruit", "", "A", "bar, kitchen", "", "", true],
    ["plastik-es-batu", "plastik es batu", "ice bags", "sacs à glace", "menage", "", "A", "bar, kitchen, gudang-atas", "", "", true],
    ["plastik-sampah", "plastik sampah", "garbage bags", "sacs poubelle", "menage", "", "A", "gudang-bawah, kitchen, gudang-atas", "", "", true],
    ["plastik-vrac", "plastik vrac", "bulk plastic bags (2/5/10 kg)", "sacs vrac 2/5/10 kg", "menage", "", "A", "kitchen, gudang-bawah, gudang-atas", "", "", true],
    ["plastik-wrap", "plastik wrap", "cling film", "film alimentaire", "menage", "", "A, N", "kitchen", "", "", true],
    ["pocari", "pocari", "Pocari Sweat", "Pocari Sweat", "boisson", "", "A", "kitchen", "", "", true],
    ["pocoy", "pokcoy", "bok choy", "pak-choï", "legume", "", "A", "kitchen", "", "", true],
    ["prostex", "prostex", "Prostex disinfectant", "désinfectant Prostex", "menage", "", "A", "laundry, gudang-bawah", "", "", true],
    ["rinso", "rinso", "laundry detergent (Rinso)", "lessive", "menage", "", "A", "laundry", "", "", true],
    ["roti", "roti", "bread", "pain / roti tawar", "feculent", "", "", "", "", "", true],
    ["sabun", "sabun", "hand / body soap", "savon main / body", "menage", "", "A, N", "gudang-atas", "", "", true],
    ["salad-oil", "salad oil", "salad oil", "huile pour salade (Kroger)", "sauce", "", "A", "kitchen", "", "", true],
    ["santan-kara", "santan kara", "coconut milk (Kara)", "lait de coco Kara", "sauce", "", "A", "kitchen", "", "", true],
    ["saos-asli", "saos asli", "local sauce (to confirm)", "sauce locale (à confirmer)", "sauce", "", "", "", "", "", true],
    ["saos-sambal", "saos sambal", "chili sauce", "sauce piment", "sauce", "", "A", "kitchen", "", "", true],
    ["saos-tiram", "saos tiram", "oyster sauce", "sauce huître", "sauce", "", "A", "kitchen", "", "", true],
    ["saos-tomat", "saos tomat", "ketchup", "Ketchup", "sauce", "", "A", "kitchen", "", "", true],
    ["sayur-ijo", "sayur ijo", "green vegetables (to confirm)", "légumes verts (variété à confirmer)", "legume", "", "", "kitchen", "", "", true],
    ["selada", "selada", "lettuce", "laitue (dont selada keriting)", "legume", "", "A", "kitchen", "", "", true],
    ["sepon", "sepon", "dish sponges / steel wool", "éponges vaisselle / spon besi", "menage", "", "A", "gudang-atas, gudang-bawah, kitchen, bar", "", "", true],
    ["skm", "skm", "sweetened condensed milk", "lait concentré sucré", "laitier", "", "A", "kitchen", "", "", true],
    ["slice-almond", "slice almond", "sliced almonds", "amandes effilées", "sucrerie", "", "A, N", "kitchen", "", "", true],
    ["soda-water", "soda water", "soda water", "eau gazeuse", "boisson", "", "A", "bar", "", "", true],
    ["sprite", "sprite", "Sprite", "Sprite", "boisson", "", "", "bar", "", "", true],
    ["sunlight", "sunlight", "dish soap (Sunlight)", "liquide vaisselle", "menage", "", "A, N", "bar, kitchen", "", "", true],
    ["susu", "susu", "fresh milk", "lait frais (Milk Life / Greenfields / Indomilk)", "laitier", "", "A", "bar", "", "", true],
    ["tahu", "tahu", "tofu", "tofu", "protine", "", "A", "kitchen", "", "", true],
    ["taoge", "taoge", "bean sprouts", "germes de haricot", "legume", "", "A", "kitchen", "", "", true],
    ["teh-celup", "teh celup", "tea bags", "thé en sachet", "aromate", "", "A, N", "kitchen", "", "", true],
    ["tempe", "tempe", "tempeh", "tempeh", "protine", "", "A", "kitchen", "", "", true],
    ["tepung-krispi", "tepung krispi", "crispy batter flour", "farine croustillante", "feculent", "", "A", "kitchen", "", "", true],
    ["tepung-roti", "tepung roti", "breadcrumbs", "chapelure", "feculent", "", "A", "kitchen", "", "", true],
    ["tepung-terigu", "tepung terigu", "wheat flour", "farine de blé", "feculent", "", "A", "kitchen", "", "", true],
    ["timun", "timun", "cucumber", "concombre", "legume", "", "A", "kitchen", "", "", true],
    ["tisu-makan", "tisu makan", "paper napkins", "serviettes en papier", "menage", "", "A, N", "bar, kitchen", "", "", true],
    ["tisu-toilet", "tisu toilet", "toilet paper", "papier toilette", "menage", "", "A, N", "gudang-atas", "", "", true],
    ["tomat", "tomat", "tomatoes", "tomate", "legume", "", "A", "kitchen", "", "", true],
    ["udang", "udang", "shrimp", "crevettes", "protine", "", "", "", "", "", true],
    ["wortel", "wortel local", "carrots", "carotte", "legume", "", "A", "kitchen", "", "", true],
    ["yogurt", "yogurt", "yogurt", "yaourt (Biokul / Greenfields / Polaris)", "laitier", "", "A", "bar", "", "", true],
    ["kacang-tanah", "kacang tanah", "peanuts", "cacahuètes", "legume", "", "", "", "", "à confirmer (page Produits achetés)", true],
    ["coconut-flakes", "coconut flakes", "coconut flakes", "noix de coco râpée", "sucrerie", "", "", "", "", "à confirmer (page Produits achetés)", true],
    ["stella", "stella gantung", "hanging air freshener", "désodorisant Stella", "menage", "", "", "", "", "à confirmer (page Produits achetés)", true],
    ["kopi-biji", "biji kopi", "coffee beans", "café en grains", "boisson", "", "", "", "", "à confirmer (page Produits achetés)", true],
    ["lemon", "lemon", "lemon", "citron jaune", "fruit", "", "", "", "", "à confirmer (page Produits achetés)", true],
    ["kertas-thermal", "kertas thermal", "receipt paper", "papier thermique (tickets)", "menage", "", "", "", "", "à confirmer (page Produits achetés)", true],
    ["terasi", "terasi", "shrimp paste", "pâte de crevettes", "aromate", "", "", "", "", "à confirmer (page Produits achetés)", true]]
};

/** Run once from the editor: creates the missing tabs with their headers and the starting lists. Safe to run again. */
function setupStock() {
  var ss = SpreadsheetApp.openById(STOCK_SHEET_ID), made = [];
  Object.keys(STOCK_TABS).forEach(function (name) {
    var sh = ss.getSheetByName(name), head = STOCK_TABS[name];
    if (!sh) { sh = ss.insertSheet(name, ss.getNumSheets()); made.push(name); } // at the end, after the owner's tabs
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
      sh.setFrozenRows(1);
      var seed = STOCK_SEED[name];
      if (seed) sh.getRange(2, 1, seed.length, seed[0].length).setValues(seed);
    }
  });
  return { ok: true, created: made };
}

/** Called by journal.gs doPost for {secret, action, ...}. */
function stockAction_(req) {
  var ss = SpreadsheetApp.openById(STOCK_SHEET_ID);
  switch (req.action) {
    case 'stock_read': return { ok: true, tabs: stockRead_(ss, req.tabs || Object.keys(STOCK_TABS)) };
    case 'stock_upsert': return stockUpsert_(ss, String(req.tab || ''), req.rows || []);
    default: throw new Error('unknown action');
  }
}

// { tab: [ {header: value, …}, … ] } for each asked tab (missing tabs come back empty).
function stockRead_(ss, names) {
  var out = {};
  names.forEach(function (name) {
    if (!STOCK_TABS[name]) throw new Error('unknown tab ' + name);
    var sh = ss.getSheetByName(name), rows = [];
    if (sh && sh.getLastRow() > 1) {
      var w = sh.getLastColumn(), vals = sh.getRange(1, 1, sh.getLastRow(), w).getValues(), head = vals[0];
      for (var i = 1; i < vals.length; i++) {
        if (vals[i][0] === '' || vals[i][0] === null) continue;
        var o = {};
        for (var j = 0; j < w; j++) if (head[j] !== '') o[head[j]] = vals[i][j] instanceof Date ? vals[i][j].toISOString() : vals[i][j];
        rows.push(o);
      }
    }
    out[name] = rows;
  });
  return out;
}

// Adds or updates rows by `id`. Only the columns given are written: a column someone added by hand is kept.
function stockUpsert_(ss, name, rows) {
  if (!STOCK_TABS[name]) throw new Error('unknown tab ' + name);
  if (!rows.length) return { ok: true, added: 0, updated: 0 };
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = ss.getSheetByName(name);
    if (!sh) throw new Error('tab ' + name + ' missing: run setupStock');
    var w = sh.getLastColumn(), head = sh.getRange(1, 1, 1, w).getValues()[0];
    var last = sh.getLastRow(), at = {}, added = 0, updated = 0;
    if (last > 1) sh.getRange(2, 1, last - 1, 1).getValues().forEach(function (r, i) { if (r[0] !== '') at[String(r[0])] = i + 2; });
    var hasStamp = head.indexOf('updated_at') >= 0, now = new Date();
    rows.forEach(function (o) {
      var id = String(o.id || '');
      if (!id) throw new Error('row without id');
      if (hasStamp) o.updated_at = now;
      var r = at[id];
      if (!r) { r = at[id] = ++last; added++; } else updated++;
      Object.keys(o).forEach(function (k) {
        var c = head.indexOf(k);
        if (c >= 0) sh.getRange(r, c + 1).setValue(o[k]);
      });
    });
    return { ok: true, added: added, updated: updated };
  } finally {
    lock.releaseLock();
  }
}
