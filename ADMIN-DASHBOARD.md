# PrintBee admin dashboard preview

Open /admin-preview.html, or use /admin.html?preview=1. The dashboard uses synthetic campus print data. Sample additions reset when you reload. Theme preference stays on this device.

The preview shows the last 30 days of orders. Conversion, signups, satisfaction and traffic use estimates or fixtures for display. CSV exports the filtered orders. Print / Save PDF opens the browser print dialog for the current dashboard view.

Theme variables live in admin-tokens.css. The renderer is in admin-dashboard.js and the fixtures are in admin-data.js.

To connect real data, load orders, products, and activity through the authenticated admin application. Use server aggregates for analytics such as traffic, signups, satisfaction, and repeat customers. Map amounts from integer paise to rupees for display and parse server timestamps as Date objects. Connect write actions to authorized endpoints and refresh the data only after those endpoints succeed. The current live admin endpoints and sign-in remain in operations.js and server.py.
