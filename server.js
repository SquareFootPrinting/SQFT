require('dotenv').config();

const fs = require('fs');
const path = require('path');
const net = require('net');

const mongoTestHost =
  'ac-ercnu4d-shard-00-00.lce6y98.mongodb.net';

const mongoTest = net.createConnection({
    host: mongoTestHost,
    port: 27017,
    timeout: 10000
});

mongoTest.on('connect', () => {
    console.log('✅ MongoDB TCP 27017 reachable from GoDaddy');
    mongoTest.destroy();
});

mongoTest.on('timeout', () => {
    console.log('❌ MongoDB TCP 27017 TIMEOUT from GoDaddy');
    mongoTest.destroy();
});

mongoTest.on('error', (err) => {
    console.log(
        '❌ MongoDB TCP connection error:',
        err.code,
        err.message
    );
});

const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const cors = require('cors');
const nodemailer = require('nodemailer');
const cloudinary = require('cloudinary').v2;
const paypal = require('@paypal/checkout-server-sdk');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);


// -----------------------------------------------------
// PAYPAL
// -----------------------------------------------------

let environment = new paypal.core.SandboxEnvironment(
    process.env.PAYPAL_CLIENT_ID,
    process.env.PAYPAL_SECRET
);

let paypalClient =
    new paypal.core.PayPalHttpClient(environment);


const app = express();


// -----------------------------------------------------
// CLOUDINARY
// -----------------------------------------------------

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});


// -----------------------------------------------------
// CORS
// -----------------------------------------------------

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);

app.use(cors(
    allowedOrigins.length
        ? {
            origin: (origin, callback) => {

                if (
                    !origin ||
                    allowedOrigins.includes(origin)
                ) {
                    return callback(null, true);
                }

                return callback(
                    new Error('Origin not allowed by CORS')
                );
            }
        }
        : undefined
));


// -----------------------------------------------------
// MODELOS
// -----------------------------------------------------
//
// IMPORTANTE:
// Se declaran ANTES del webhook de Stripe para que
// el webhook pueda actualizar la orden en MongoDB.
//

const User = mongoose.model(
    'User',
    new mongoose.Schema({

        name: {
            type: String,
            required: true
        },

        email: {
            type: String,
            required: true,
            unique: true
        },

        password: {
            type: String,
            required: true
        },

        isWholesale: {
            type: Boolean,
            default: false
        },

        role: {
            type: String,
            default: 'customer'
        }
    })
);


const Order = mongoose.model(
    'Order',
    new mongoose.Schema({

        order_id: String,

        customer_name: String,

        customer_email: String,

        customer_phone: String,

        total_price: String,

        order_items: Array,

        status: {
            type: String,
            default: 'Pending'
        },

        payment_status: {
            type: String,
            default: 'Pending'
        },

        transaction_id: {
            type: String,
            default: ''
        },

        createdAt: {
            type: Date,
            default: Date.now
        }
    })
);


const PricingOverride = mongoose.model(
    'PricingOverride',
    new mongoose.Schema({
        path: {
            type: String,
            required: true,
            unique: true,
            trim: true
        },
        value: {
            type: Number,
            required: true
        },
        updatedBy: {
            type: String,
            default: ''
        },
        updatedAt: {
            type: Date,
            default: Date.now
        }
    })
);


// Full pricing catalog. MongoDB is the primary pricing source for the storefront.
// pricing-v2.js remains only as a fallback when the API is unavailable.
const PricingCatalog = mongoose.model(
    'PricingCatalog',
    new mongoose.Schema({
        key: { type: String, required: true, unique: true, default: 'storefront' },
        pricing: { type: mongoose.Schema.Types.Mixed, required: true, default: {} },
        updatedAt: { type: Date, default: Date.now }
    }, { minimize: false })
);



// -----------------------------------------------------
// STRIPE WEBHOOK
// -----------------------------------------------------
//
// MUY IMPORTANTE:
//
// Este endpoint tiene que estar ANTES de express.json().
//
// Stripe necesita recibir el body ORIGINAL para verificar
// que el evento realmente fue enviado por Stripe.
//

app.post(
    '/api/stripe/webhook',

    express.raw({
        type: 'application/json'
    }),

    async (req, res) => {

        const signature =
            req.headers['stripe-signature'];

        let event;

        try {

            event =
                stripe.webhooks.constructEvent(
                    req.body,
                    signature,
                    process.env.STRIPE_WEBHOOK_SECRET
                );

        } catch (error) {

            console.error(
                '❌ Stripe webhook signature error:',
                error.message
            );

            return res
                .status(400)
                .send(
                    `Webhook Error: ${error.message}`
                );
        }


        try {

            if (
                event.type ===
                'checkout.session.completed'
            ) {

                const session =
                    event.data.object;


                if (
                    session.payment_status === 'paid'
                ) {

                    const orderDatabaseId =
                        session.metadata
                            ?.orderDatabaseId;


                    if (!orderDatabaseId) {

                        console.error(
                            '❌ Stripe payment received without orderDatabaseId'
                        );

                        return res
                            .status(400)
                            .json({
                                received: false,
                                error:
                                    'Missing orderDatabaseId'
                            });
                    }


                    const updatedOrder =
                        await Order
                            .findByIdAndUpdate(

                                orderDatabaseId,

                                {
                                    payment_status:
                                        'Paid',

                                    status:
                                        'Processing',

                                    transaction_id:
                                        session.payment_intent ||
                                        session.id
                                },

                                {
                                    new: true
                                }
                            );


                    if (!updatedOrder) {

                        console.error(
                            `❌ MongoDB order not found: ${orderDatabaseId}`
                        );

                        return res
                            .status(404)
                            .json({
                                received: false,
                                error:
                                    'Order not found'
                            });
                    }


                    console.log(
                        `✅ Stripe payment confirmed for order ${updatedOrder.order_id}`
                    );
                }
            }


            return res.json({
                received: true
            });


        } catch (error) {

            console.error(
                '❌ Stripe webhook processing error:',
                error
            );

            return res
                .status(500)
                .json({
                    received: false
                });
        }
    }
);


// -----------------------------------------------------
// JSON PARA TODAS LAS DEMÁS RUTAS
// -----------------------------------------------------

app.use(
    express.json({
        limit: '2mb'
    })
);


// -----------------------------------------------------
// MONGODB
// -----------------------------------------------------

mongoose
    .connect(process.env.MONGO_URI)

    .then(() =>
        console.log(
            '✅ Connected to MongoDB Atlas'
        )
    )

    .catch(err =>
        console.error(
            '❌ Connection Error:',
            err
        )
    );


// -----------------------------------------------------
// EMAIL
// -----------------------------------------------------

const transporter =
    nodemailer.createTransport({

        service: 'gmail',

        auth: {

            user:
                process.env.GMAIL_USER,

            pass:
                process.env.GMAIL_PASS
        }
    });


// -----------------------------------------------------
// AUTENTICACIÓN
// -----------------------------------------------------

const authMiddleware =
    (req, res, next) => {

        const token =
            req.header('x-auth-token');


        if (!token) {

            return res
                .status(401)
                .json({
                    msg:
                        'No token, authorization denied'
                });
        }


        try {

            const decoded =
                jwt.verify(
                    token,
                    process.env.JWT_SECRET ||
                    'secretSFP'
                );

            req.user =
                decoded;

            next();

        } catch (e) {

            res
                .status(400)
                .json({
                    msg:
                        'Token is not valid'
                });
        }
    };


// -----------------------------------------------------
// EMAIL TEMPLATE
// -----------------------------------------------------

const emailTemplate =
    (orderData) => {

        const itemsHtml =
            orderData.order_items
                .map((item, i) => {

                    const detailsArray =
                        item.details
                            ? item.details.split(/[|\n]/)
                            : [];


                    const detailsHtml =
                        detailsArray

                            .map(
                                detail =>
                                    detail.trim()
                            )

                            .filter(
                                detail =>
                                    detail.length > 0
                            )

                            .map(
                                detail =>
                                    `<li style="margin-bottom: 2px;">• ${detail.toUpperCase()}</li>`
                            )

                            .join('');


                    return `

                    <div style="margin-bottom: 30px; font-family: Arial, sans-serif; border-bottom: 1px solid #eee; padding-bottom: 15px;">

                        <strong style="font-size: 16px; color: #000; display: block; margin-bottom: 5px;">

                            ITEM #${i + 1}: ${item.name.toUpperCase()}

                        </strong>

                        <ul style="list-style: none; padding: 0; margin: 0; color: #666; font-size: 13px; line-height: 1.5;">

                            ${detailsHtml}

                            <li style="margin-bottom: 2px; font-weight: bold; color: #000;">
                                • PRICE: $${item.price}
                            </li>

                        </ul>

                        ${
                            item.fileUrl
                                ? `

                        <div style="margin-top: 15px;">

                            <a
                                href="${item.fileUrl}"
                                style="display: inline-block; background: #000; color: #fff; padding: 10px 18px; text-decoration: none; border-radius: 5px; font-weight: bold; font-size: 11px;"
                            >
                                DOWNLOAD PRINT FILE
                            </a>

                        </div>

                        `
                                : ''
                        }

                    </div>

                    `;
                })

                .join('');


        return `

        <html>

        <body style="font-family: Arial, sans-serif; background-color: #ffffff; margin: 0; padding: 20px;">

            <div style="max-width: 600px; margin: auto; border: 1px solid #eee; border-radius: 8px; overflow: hidden;">

                <div style="background: #000; padding: 30px; text-align: center;">

                    <img
                        src="cid:logo_sfp"
                        alt="SQUARE FOOT PRINTING"
                        style="width: 250px; height: auto;"
                    >

                </div>

                <div style="padding: 30px;">

                    <h1 style="font-size: 24px; margin-bottom: 20px; color: #000;">
                        New Order Received!
                    </h1>

                    <p style="font-size: 14px;">
                        <strong>Order ID:</strong>
                        ${orderData.order_id}
                    </p>

                    <p style="font-size: 14px;">
                        <strong>Customer:</strong>
                        ${orderData.customer_name}
                    </p>

                    <p style="font-size: 14px;">
                        <strong>Phone:</strong>
                        ${orderData.customer_phone}
                    </p>

                    <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">

                    <h2 style="font-size: 16px; letter-spacing: 1px; text-transform: uppercase;">
                        Order Summary
                    </h2>

                    ${itemsHtml}

                    <div style="text-align: right; margin-top: 20px;">

                        <h2 style="font-size: 22px; color: #000;">
                            TOTAL: $${orderData.total_price}
                        </h2>

                    </div>

                </div>

            </div>

        </body>

        </html>

        `;
    };


// -----------------------------------------------------
// UPLOADS
// -----------------------------------------------------

const ALLOWED_ARTWORK_TYPES =
    new Set([

        'image/jpeg',

        'image/png',

        'application/pdf'
    ]);


const upload =
    multer({

        dest: '/tmp/',

        limits: {

            fileSize:
                50 * 1024 * 1024
        },

        fileFilter:
            (req, file, cb) => {

                if (
                    ALLOWED_ARTWORK_TYPES
                        .has(file.mimetype)
                ) {

                    return cb(
                        null,
                        true
                    );
                }

                cb(
                    new Error(
                        'Only JPG, PNG and PDF artwork files are allowed'
                    )
                );
            }
    });


// =====================================================
// RUTAS
// =====================================================


// -----------------------------------------------------
// REGISTRO
// -----------------------------------------------------

app.post(
    '/api/auth/register',

    async (req, res) => {

        try {

            const {
                name,
                email,
                password,
                inviteCode
            } = req.body;


            let user =
                await User.findOne({
                    email
                });


            if (user) {

                return res
                    .status(400)
                    .json({

                        success: false,

                        message:
                            'Email already exists'
                    });
            }


            const salt =
                await bcrypt.genSalt(10);


            const hashedPassword =
                await bcrypt.hash(
                    password,
                    salt
                );


            const isWholesale =
                (
                    inviteCode &&
                    inviteCode
                        .trim()
                        .toLowerCase() ===
                        'sight2026'
                );


            user =
                new User({

                    name,

                    email:
                        email.toLowerCase(),

                    password:
                        hashedPassword,

                    isWholesale
                });


            await user.save();


            res
                .status(201)
                .json({

                    success: true,

                    message:
                        'User registered'
                });


        } catch (error) {

            res
                .status(500)
                .json({

                    success: false,

                    message:
                        error.message
                });
        }
    }
);


// -----------------------------------------------------
// LOGIN
// -----------------------------------------------------

app.post(
    '/api/auth/login',

    async (req, res) => {

        try {

            const {
                email,
                password
            } = req.body;


            const user =
                await User.findOne({

                    email:
                        email
                            .trim()
                            .toLowerCase()
                });


            if (!user) {

                return res
                    .status(400)
                    .json({

                        success: false,

                        message:
                            'User not found'
                    });
            }


            const isMatch =
                await bcrypt.compare(
                    password,
                    user.password
                );


            if (!isMatch) {

                return res
                    .status(400)
                    .json({

                        success: false,

                        message:
                            'Invalid credentials'
                    });
            }


            const token =
                jwt.sign(

                    {
                        id:
                            user._id,

                        role:
                            user.role
                    },

                    process.env.JWT_SECRET ||
                    'secretSFP',

                    {
                        expiresIn:
                            '8h'
                    }
                );


            res.json({

                success: true,

                token,

                user: {

                    name:
                        user.name,

                    email:
                        user.email,

                    isWholesale:
                        user.isWholesale,

                    role:
                        user.role
                }
            });


        } catch (error) {

            res
                .status(500)
                .json({

                    success: false,

                    message:
                        error.message
                });
        }
    }
);


// -----------------------------------------------------
// CREAR ORDEN
// -----------------------------------------------------

app.post(
    '/api/place-order',

    async (req, res) => {

        try {

            const orderData =
                req.body;


            const newOrder =
                new Order({

                    order_id:
                        orderData.order_id,

                    customer_name:
                        orderData.customer_name,

                    customer_email:
                        orderData.customer_email,

                    customer_phone:
                        orderData.customer_phone,

                    total_price:
                        orderData.total_price,

                    order_items:
                        orderData.order_items,

                    payment_status:
                        orderData.payment_status ||
                        'Pending',

                    transaction_id:
                        orderData.transaction_id ||
                        ''
                });


            await newOrder.save();


            transporter
                .sendMail({

                    from:
                        '"SFP Orders" <ventas@sfp-lasvegas.com>',

                    to:
                        'za19012245@zapopan.tecmm.edu.mx',

                    subject:
                        `New Order: ${orderData.order_id}`,

                    html:
                        emailTemplate(orderData),

                    attachments: [

                        {

                            filename:
                                'logo.jpg',

                            path:
                                './images/SquareFootPrinting-Logo-White-Text-Lrg-01-e1525129997491.jpg',

                            cid:
                                'logo_sfp'
                        }
                    ]
                })

                .catch(
                    err =>
                        console.log(
                            '❌ Email Error:',
                            err.message
                        )
                );


            res
                .status(200)
                .json({

                    success: true,

                    id:
                        newOrder._id
                });


        } catch (error) {

            res
                .status(500)
                .json({

                    success: false,

                    error:
                        error.message
                });
        }
    }
);



// -----------------------------------------------------
// PRICING OVERRIDES
// -----------------------------------------------------

// One-time protected migration for Render Free plans (no Shell access).
// Creates the MongoDB storefront catalog from pricing-seed.json and preserves
// any legacy PricingOverride values. It refuses to overwrite an existing catalog.
app.post('/api/admin/migrate-pricing', authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'admin') {
            return res.status(403).json({ msg: 'Forbidden' });
        }

        const existing = await PricingCatalog.findOne({ key: 'storefront' }).lean();
        if (existing) {
            return res.status(409).json({
                msg: 'Pricing catalog already exists. Migration was not run again.',
                migrated: false,
                updatedAt: existing.updatedAt
            });
        }

        const seedPath = path.join(__dirname, 'pricing-seed.json');
        const pricing = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
        const sourceNames = new Set(Object.keys(pricing));
        const blocked = new Set(['__proto__', 'prototype', 'constructor']);

        function applyOverride(root, overridePath, value) {
            const parts = String(overridePath || '').split('.');
            const source = parts.shift();
            if (!sourceNames.has(source) || !root[source]) return false;
            const numeric = Number(value);
            if (!Number.isFinite(numeric) || numeric < 0) return false;

            function resolve(target, remaining) {
                if (!target || typeof target !== 'object' || !remaining.length) return null;
                for (let take = remaining.length; take >= 1; take--) {
                    const key = remaining.slice(0, take).join('.');
                    if (blocked.has(key) || !Object.prototype.hasOwnProperty.call(target, key)) continue;
                    if (take === remaining.length) return { target, key };
                    const found = resolve(target[key], remaining.slice(take));
                    if (found) return found;
                }
                return null;
            }

            const found = resolve(root[source], parts);
            if (!found) return false;
            found.target[found.key] = numeric;
            return true;
        }

        const overrides = await PricingOverride.find({}).lean();
        let applied = 0;
        for (const item of overrides) {
            if (applyOverride(pricing, item.path, item.value)) applied++;
        }

        const catalog = await PricingCatalog.create({
            key: 'storefront',
            pricing,
            updatedAt: new Date()
        });

        console.log(`✅ Pricing catalog migrated by admin: ${Object.keys(pricing).length} sources, ${applied}/${overrides.length} overrides applied.`);
        return res.status(201).json({
            success: true,
            migrated: true,
            key: catalog.key,
            sources: Object.keys(pricing).length,
            overridesApplied: applied,
            overridesFound: overrides.length,
            updatedAt: catalog.updatedAt
        });
    } catch (error) {
        console.error('❌ Admin pricing migration failed:', error);
        return res.status(500).json({ error: error.message });
    }
});

// Public full-pricing endpoint. This is now the storefront's primary source.
app.get('/api/pricing', async (req, res) => {
    try {
        const catalog = await PricingCatalog.findOne({ key: 'storefront' }).lean();
        if (!catalog || !catalog.pricing) {
            return res.status(404).json({
                error: 'Pricing catalog has not been migrated yet.',
                fallback: true
            });
        }
        res.set('Cache-Control', 'no-store');
        res.json({ pricing: catalog.pricing, updatedAt: catalog.updatedAt });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Admin write endpoint for the authoritative MongoDB pricing catalog.
// The admin editor sends the complete pricing object so keys such as "3.00"
// are preserved exactly and are not interpreted as MongoDB dotted paths.
app.put('/api/admin/pricing', authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'admin') {
            return res.status(403).json({ msg: 'Forbidden' });
        }

        const pricing = req.body?.pricing;
        if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) {
            return res.status(400).json({ msg: 'A complete pricing object is required.' });
        }

        const validatePricing = (value, path = 'pricing') => {
            if (typeof value === 'number') {
                if (!Number.isFinite(value) || value < 0) {
                    throw new Error(`Invalid numeric value at ${path}`);
                }
                return;
            }
            if (Array.isArray(value)) {
                value.forEach((item, index) => validatePricing(item, `${path}[${index}]`));
                return;
            }
            if (value && typeof value === 'object') {
                Object.entries(value).forEach(([key, child]) => validatePricing(child, `${path}.${key}`));
            }
        };

        validatePricing(pricing);

        const catalog = await PricingCatalog.findOneAndUpdate(
            { key: 'storefront' },
            { $set: { pricing, updatedAt: new Date() } },
            { new: true, upsert: false, runValidators: true }
        ).lean();

        if (!catalog) {
            return res.status(404).json({ msg: 'Pricing catalog has not been initialized.' });
        }

        res.set('Cache-Control', 'no-store');
        res.json({ success: true, pricing: catalog.pricing, updatedAt: catalog.updatedAt });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Legacy override endpoints are kept temporarily for backward compatibility.
app.get('/api/pricing-overrides', async (req, res) => {
    try {
        const records = await PricingOverride.find().sort({ path: 1 }).lean();
        res.json(records.map(record => ({
            path: record.path,
            value: record.value,
            updatedAt: record.updatedAt
        })));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put(
    '/api/admin/pricing-overrides',
    authMiddleware,
    async (req, res) => {
        try {
            if (req.user.role !== 'admin') {
                return res.status(403).json({ msg: 'Forbidden' });
            }

            const changes = Array.isArray(req.body?.changes)
                ? req.body.changes
                : [];

            if (!changes.length) {
                return res.status(400).json({ msg: 'No pricing changes supplied.' });
            }

            const safePath = /^[A-Za-z0-9_$./ -]+$/;
            const operations = [];

            for (const change of changes) {
                const path = String(change?.path || '').trim();
                const value = Number(change?.value);

                if (!path || !safePath.test(path) || !Number.isFinite(value) || value < 0) {
                    return res.status(400).json({
                        msg: `Invalid pricing value for ${path || 'unknown field'}`
                    });
                }

                operations.push({
                    updateOne: {
                        filter: { path },
                        update: {
                            $set: {
                                value,
                                updatedBy: req.user.email || req.user.id || 'admin',
                                updatedAt: new Date()
                            }
                        },
                        upsert: true
                    }
                });
            }

            await PricingOverride.bulkWrite(operations);

            res.json({
                success: true,
                saved: operations.length
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }
);

app.delete(
    '/api/admin/pricing-overrides/:encodedPath',
    authMiddleware,
    async (req, res) => {
        try {
            if (req.user.role !== 'admin') {
                return res.status(403).json({ msg: 'Forbidden' });
            }

            const path = decodeURIComponent(req.params.encodedPath || '');
            await PricingOverride.deleteOne({ path });

            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }
);

app.delete(
    '/api/admin/pricing-overrides',
    authMiddleware,
    async (req, res) => {
        try {
            if (req.user.role !== 'admin') {
                return res.status(403).json({ msg: 'Forbidden' });
            }

            const result = await PricingOverride.deleteMany({});
            res.json({ success: true, deleted: result.deletedCount || 0 });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }
);


// -----------------------------------------------------
// ADMIN - OBTENER ÓRDENES
// -----------------------------------------------------

app.get(
    '/api/admin/orders',

    authMiddleware,

    async (req, res) => {

        try {

            if (
                req.user.role !== 'admin'
            ) {

                return res
                    .status(403)
                    .json({

                        msg:
                            'Forbidden'
                    });
            }


            const orders =
                await Order
                    .find()
                    .sort({

                        createdAt:
                            -1
                    });


            res.json(
                orders
            );


        } catch (error) {

            res
                .status(500)
                .json({

                    error:
                        error.message
                });
        }
    }
);


// -----------------------------------------------------
// ADMIN - ACTUALIZAR ORDEN
// -----------------------------------------------------

app.patch(
    '/api/admin/orders/:id/status',

    authMiddleware,

    async (req, res) => {

        try {

            if (
                req.user.role !== 'admin'
            ) {

                return res
                    .status(403)
                    .json({

                        msg:
                            'No autorizado'
                    });
            }


            const {
                status
            } = req.body;


            const updatedOrder =
                await Order
                    .findByIdAndUpdate(

                        req.params.id,

                        {
                            status
                        },

                        {
                            new: true
                        }
                    );


            res.json(
                updatedOrder
            );


        } catch (error) {

            res
                .status(500)
                .json({

                    error:
                        error.message
                });
        }
    }
);


// -----------------------------------------------------
// CLOUDINARY UPLOAD
// -----------------------------------------------------

app.post(
    '/api/upload-preview',

    (req, res) => {

        upload.single('file')(
            req,
            res,

            async (uploadError) => {

                if (uploadError) {

                    const status =
                        uploadError.code ===
                        'LIMIT_FILE_SIZE'
                            ? 413
                            : 400;


                    return res
                        .status(status)
                        .json({

                            success: false,

                            error:
                                uploadError.message
                        });
                }


                if (!req.file) {

                    return res
                        .status(400)
                        .json({

                            success: false,

                            error:
                                'No artwork file received'
                        });
                }


                try {

                    const result =
                        await cloudinary
                            .uploader
                            .upload(

                                req.file.path,

                                {

                                    folder:
                                        'sfp_orders',

                                    resource_type:
                                        'auto'
                                }
                            );


                    res.json({

                        success: true,

                        url:
                            result.secure_url
                    });


                } catch (error) {

                    res
                        .status(500)
                        .json({

                            success: false,

                            error:
                                error.message
                        });


                } finally {

                    if (
                        req.file?.path &&
                        fs.existsSync(
                            req.file.path
                        )
                    ) {

                        fs.unlinkSync(
                            req.file.path
                        );
                    }
                }
            }
        );
    }
);


// -----------------------------------------------------
// STRIPE - CREAR CHECKOUT SESSION
// -----------------------------------------------------

app.post(
    '/api/checkout/create-stripe-session',

    async (req, res) => {

        try {

            const {
                orderDatabaseId
            } = req.body;


            if (!orderDatabaseId) {

                return res
                    .status(400)
                    .json({

                        success: false,

                        error:
                            'Missing order ID'
                    });
            }


            const order =
                await Order.findById(
                    orderDatabaseId
                );


            if (!order) {

                return res
                    .status(404)
                    .json({

                        success: false,

                        error:
                            'Order not found'
                    });
            }


           const numericTotal = Number(
    String(order.total_price).replace(/[$,]/g, '')
);

const amount = Math.round(numericTotal * 100);


            if (
                !Number.isInteger(amount) ||
                amount < 50
            ) {

                return res
                    .status(400)
                    .json({

                        success: false,

                        error:
                            'Invalid order total'
                    });
            }


            const session =
                await stripe
                    .checkout
                    .sessions
                    .create({

                        mode:
                            'payment',

                        payment_method_types:
                            [
                                'card'
                            ],

                        line_items: [

                            {

                                price_data: {

                                    currency:
                                        'usd',

                                    product_data: {

                                        name:
                                            `Square Foot Printing - Order ${order.order_id}`
                                    },

                                    unit_amount:
                                        amount
                                },

                                quantity:
                                    1
                            }
                        ],

                        customer_email:
                            order.customer_email ||
                            undefined,

                        metadata: {

                            orderDatabaseId:
                                order._id
                                    .toString(),

                            orderId:
                                order.order_id ||
                                ''
                        },

                        success_url:
                            'https://sqftprinting.com/order-confirmation.html?stripe_session={CHECKOUT_SESSION_ID}',

                        cancel_url:
                            'https://sqftprinting.com/checkout.html?payment=cancelled'
                    });


            res.json({

                success: true,

                sessionId:
                    session.id,

                url:
                    session.url
            });


        } catch (error) {

            console.error(
                '❌ Stripe Session Error:',
                error
            );


            res
                .status(500)
                .json({

                    success: false,

                    error:
                        error.message
                });
        }
    }
);


// -----------------------------------------------------
// PAYPAL - CREAR ORDEN
// -----------------------------------------------------

app.post(
    '/api/checkout/create-paypal-order',

    async (req, res) => {

        try {

            const {
                items,
                userEmail
            } = req.body;


            const user =
                await User.findOne({

                    email:
                        userEmail
                });


            const isWholesale =
                user
                    ? user.isWholesale
                    : false;


            let totalAmount =
                0;


            for (
                const item of items
            ) {

                const priceRecord =
                    await Pricing.findOne({

                        productId:
                            item.productId,

                        variantKey:
                            item.variantKey ||
                            'base'
                    });


                if (!priceRecord) {

                    return res
                        .status(403)
                        .json({

                            error:
                                `Producto no autorizado: ${item.name}`
                        });
                }


                let price =
                    priceRecord.price;


                if (
                    priceRecord.type ===
                    'sqft'
                ) {

                    price =
                        price *
                        (
                            Math.max(
                                1,
                                item.width
                            ) *
                            Math.max(
                                1,
                                item.height
                            )
                        );
                }


                const finalPrice =
                    isWholesale
                        ? price
                        : price * 2;


                totalAmount +=
                    finalPrice *
                    (
                        item.quantity ||
                        1
                    );
            }


            const request =
                new paypal
                    .orders
                    .OrdersCreateRequest();


            request.requestBody({

                intent:
                    'CAPTURE',

                purchase_units: [

                    {

                        amount: {

                            currency_code:
                                'USD',

                            value:
                                totalAmount
                                    .toFixed(2)
                        }
                    }
                ]
            });


            const order =
                await paypalClient
                    .execute(request);


            res.json({

                id:
                    order.result.id
            });


        } catch (err) {

            res
                .status(500)
                .json({

                    error:
                        err.message
                });
        }
    }
);


// -----------------------------------------------------
// PAYPAL - CAPTURAR PAGO
// -----------------------------------------------------

app.post(
    '/api/checkout/capture-paypal-order',

    async (req, res) => {

        const {
            orderID,
            orderDatabaseId
        } = req.body;


        const request =
            new paypal
                .orders
                .OrdersCaptureRequest(
                    orderID
                );


        request.requestBody({});


        try {

            const capture =
                await paypalClient
                    .execute(request);


            if (
                capture.result.status ===
                'COMPLETED'
            ) {

                const transactionId =
                    capture
                        .result
                        .purchase_units[0]
                        .payments
                        .captures[0]
                        .id;


                await Order
                    .findByIdAndUpdate(

                        orderDatabaseId,

                        {

                            payment_status:
                                'Paid',

                            transaction_id:
                                transactionId,

                            status:
                                'Processing'
                        }
                    );


                res.json({

                    success: true,

                    details:
                        capture.result
                });


            } else {

                res
                    .status(400)
                    .json({

                        success: false,

                        message:
                            'Pago no completado'
                    });
            }


        } catch (err) {

            console.error(
                'Error capturando pago:',
                err
            );


            res
                .status(500)
                .json({

                    success: false,

                    error:
                        err.message
                });
        }
    }
);


// -----------------------------------------------------
// TRACK ORDER
// -----------------------------------------------------

app.get(
    '/api/orders/track/:orderId',

    async (req, res) => {

        try {

            const orderId =
                req.params
                    .orderId
                    .trim();


            const order =
                await Order.findOne({

                    order_id:
                        orderId
                });


            if (!order) {

                return res
                    .status(404)
                    .json({

                        success: false,

                        message:
                            'Order not found'
                    });
            }


            res.json({

                success: true,

                order_id:
                    order.order_id,

                status:
                    order.status,

                items:
                    order.order_items ||
                    []
            });


        } catch (error) {

            res
                .status(500)
                .json({

                    success: false,

                    message:
                        error.message
                });
        }
    }
);


// -----------------------------------------------------
// START SERVER
// -----------------------------------------------------

const PORT =
    process.env.PORT ||
    3000;


app.listen(
    PORT,

    () =>
        console.log(
            `🚀 Server Square Foot Printing ready on port ${PORT}`
        )
);