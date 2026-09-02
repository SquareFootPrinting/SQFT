# Server-side pricing migration status

## Protected now
- Gallery Canvas (`gallery-canvas`)
- 13oz Standard Banner (`standard-banner`)
- Mesh Banner (`mesh-banner`)
- Super Smooth Banner (`super-smooth`)
- HD Banner 18oz (`hd-banner-18oz`)
- Custom Sticker (`custom-sticker`)
- X-Stand Display (`x-stand`)

For these products, the backend recalculates the authoritative line price from MongoDB pricing plus canonical configuration (dimensions/options/quantity and authenticated retail/wholesale tier). Browser `item.price` is ignored and the server-calculated price is stored on the order.

## Still to migrate
The remaining product calculators still use legacy submitted line price plus server-side production minimum validation. They must be migrated product-by-product before Stripe Live Mode.
