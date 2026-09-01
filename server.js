require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const cors = require('cors');
const cloudinary = require('cloudinary').v2;
const paypal = require('@paypal/checkout-server-sdk');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);


// -----------------------------------------------------
// PAYPAL
// -----------------------------------------------------

const PayPalEnvironment = String(process.env.PAYPAL_MODE || 'sandbox').toLowerCase() === 'live'
    ? paypal.core.LiveEnvironment
    : paypal.core.SandboxEnvironment;

let environment = new PayPalEnvironment(
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
        },

        resetCodeHash: {
            type: String,
            default: null
        },

        resetCodeExpires: {
            type: Date,
            default: null
        },

        resetCodeAttempts: {
            type: Number,
            default: 0
        },

        resetCodeLastSentAt: {
            type: Date,
            default: null
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

        delivery_method: { type: String, default: 'pickup' },
        shipping_address: { type: mongoose.Schema.Types.Mixed, default: null },
        shipping_service: { type: mongoose.Schema.Types.Mixed, default: null },
        shipping_cost: { type: Number, default: 0 },
        payment_method: { type: String, default: '' },
        zelle_reference: { type: String, default: '' },
        tracking_number: { type: String, default: '' },
        carrier: { type: String, default: '' },

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
// EMAIL (RESEND API)
// -----------------------------------------------------

async function sendEmail({ to, subject, html, replyTo }) {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.EMAIL_FROM || 'Square Foot Printing <orders@squarefootprinting.com>';

    if (!apiKey) {
        throw new Error('RESEND_API_KEY is not configured');
    }

    const payload = {
        from,
        to: Array.isArray(to) ? to : [to],
        subject,
        html
    };

    if (replyTo) {
        payload.reply_to = replyTo;
    }

    const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(data.message || data.name || `Resend error (${response.status})`);
    }

    return data;
}

function hashResetCode(email, code) {
    const secret = process.env.JWT_SECRET || process.env.SHIPPING_QUOTE_SECRET || 'sfp-reset-fallback';
    return crypto
        .createHmac('sha256', secret)
        .update(`${String(email).trim().toLowerCase()}:${String(code)}`)
        .digest('hex');
}

function resetCodeEmailTemplate(code) {
    return `
    <div style="background:#f4f4f4;padding:32px 16px;font-family:Arial,sans-serif;color:#111;">
        <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e8e8e8;border-radius:16px;overflow:hidden;">
            <div style="background:#000;padding:24px;text-align:center;">
                <div style="color:#fff;font-weight:800;font-size:22px;letter-spacing:.5px;">SQUARE FOOT PRINTING</div>
            </div>
            <div style="padding:32px;">
                <h2 style="margin:0 0 12px;font-size:22px;">Password reset code</h2>
                <p style="margin:0 0 24px;color:#555;line-height:1.6;">
                    Use this code to reset your Square Foot Printing account password.
                </p>
                <div style="font-size:38px;letter-spacing:10px;font-weight:800;text-align:center;background:#f5f5f5;border-radius:12px;padding:20px 10px;margin:0 0 22px;">
                    ${code}
                </div>
                <p style="margin:0;color:#666;font-size:13px;line-height:1.6;">
                    This code expires in 10 minutes. If you did not request a password reset, you can ignore this email.
                </p>
            </div>
        </div>
    </div>`;
}


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
                        src="https://squarefootprinting.com/images/SquareFootPrinting-Logo-White-Text-Lrg-01-e1525129997491.jpg"
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
// FORGOT PASSWORD - 6 DIGIT EMAIL CODE
// -----------------------------------------------------

app.post('/api/auth/forgot-password', async (req, res) => {
    const genericResponse = {
        success: true,
        message: 'If an account exists for this email, a reset code has been sent.'
    };

    try {
        const email = String(req.body?.email || '').trim().toLowerCase();

        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({
                success: false,
                message: 'Enter a valid email address.'
            });
        }

        const user = await User.findOne({ email });

        // Keep the same response for existing and non-existing accounts.
        if (!user) {
            return res.json(genericResponse);
        }

        const now = Date.now();
        const lastSent = user.resetCodeLastSentAt
            ? new Date(user.resetCodeLastSentAt).getTime()
            : 0;

        // One code per minute per account.
        if (lastSent && now - lastSent < 60 * 1000) {
            return res.json(genericResponse);
        }

        const code = crypto.randomInt(100000, 1000000).toString();

        user.resetCodeHash = hashResetCode(email, code);
        user.resetCodeExpires = new Date(now + 10 * 60 * 1000);
        user.resetCodeAttempts = 0;
        user.resetCodeLastSentAt = new Date(now);
        await user.save();

        try {
            await sendEmail({
                to: email,
                subject: 'Your Square Foot Printing password reset code',
                html: resetCodeEmailTemplate(code)
            });
        } catch (emailError) {
            // Do not leave a usable reset code if delivery failed.
            user.resetCodeHash = null;
            user.resetCodeExpires = null;
            user.resetCodeAttempts = 0;
            await user.save();

            console.error('❌ Resend password reset email error:', emailError.message);
            return res.status(503).json({
                success: false,
                message: 'We could not send the reset email right now. Please try again shortly.'
            });
        }

        return res.json(genericResponse);
    } catch (error) {
        console.error('Forgot password error:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Unable to process password reset right now.'
        });
    }
});


app.post('/api/auth/verify-reset-code', async (req, res) => {
    try {
        const email = String(req.body?.email || '').trim().toLowerCase();
        const code = String(req.body?.code || '').trim();

        if (!email || !/^\d{6}$/.test(code)) {
            return res.status(400).json({
                success: false,
                message: 'Enter the 6-digit code from your email.'
            });
        }

        const user = await User.findOne({ email });

        if (
            !user ||
            !user.resetCodeHash ||
            !user.resetCodeExpires ||
            new Date(user.resetCodeExpires).getTime() < Date.now()
        ) {
            return res.status(400).json({
                success: false,
                message: 'The code is invalid or has expired. Request a new one.'
            });
        }

        if ((user.resetCodeAttempts || 0) >= 5) {
            user.resetCodeHash = null;
            user.resetCodeExpires = null;
            user.resetCodeAttempts = 0;
            await user.save();

            return res.status(429).json({
                success: false,
                message: 'Too many attempts. Request a new code.'
            });
        }

        const submittedHash = hashResetCode(email, code);

        const expectedBuffer = Buffer.from(user.resetCodeHash, 'hex');
        const submittedBuffer = Buffer.from(submittedHash, 'hex');

        const matches =
            expectedBuffer.length === submittedBuffer.length &&
            crypto.timingSafeEqual(expectedBuffer, submittedBuffer);

        if (!matches) {
            user.resetCodeAttempts = (user.resetCodeAttempts || 0) + 1;
            await user.save();

            return res.status(400).json({
                success: false,
                message: 'The code is invalid or has expired. Request a new one.'
            });
        }

        // Invalidate the email code as soon as it is successfully verified.
        user.resetCodeHash = null;
        user.resetCodeExpires = null;
        user.resetCodeAttempts = 0;
        await user.save();

        const resetToken = jwt.sign(
            {
                id: user._id,
                purpose: 'password_reset'
            },
            process.env.JWT_SECRET || 'secretSFP',
            { expiresIn: '10m' }
        );

        return res.json({
            success: true,
            resetToken
        });
    } catch (error) {
        console.error('Verify reset code error:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Unable to verify the code right now.'
        });
    }
});


app.post('/api/auth/reset-password', async (req, res) => {
    try {
        const resetToken = String(req.body?.resetToken || '');
        const password = String(req.body?.password || '');

        if (password.length < 8) {
            return res.status(400).json({
                success: false,
                message: 'Password must be at least 8 characters.'
            });
        }

        let payload;

        try {
            payload = jwt.verify(
                resetToken,
                process.env.JWT_SECRET || 'secretSFP'
            );
        } catch (error) {
            return res.status(400).json({
                success: false,
                message: 'Your reset session expired. Request a new code.'
            });
        }

        if (payload?.purpose !== 'password_reset' || !payload?.id) {
            return res.status(400).json({
                success: false,
                message: 'Invalid password reset session.'
            });
        }

        const user = await User.findById(payload.id);

        if (!user) {
            return res.status(400).json({
                success: false,
                message: 'Invalid password reset session.'
            });
        }

        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(password, salt);
        user.resetCodeHash = null;
        user.resetCodeExpires = null;
        user.resetCodeAttempts = 0;
        user.resetCodeLastSentAt = null;
        await user.save();

        return res.json({
            success: true,
            message: 'Password changed successfully.'
        });
    } catch (error) {
        console.error('Reset password error:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Unable to change your password right now.'
        });
    }
});


// -----------------------------------------------------
// ORDER TOTAL + SHIPPING HELPERS
// -----------------------------------------------------

function moneyNumber(value) {
    const n = Number(String(value ?? 0).replace(/[$,]/g, ''));
    return Number.isFinite(n) ? n : 0;
}

async function calculateServerOrderTotal(items = [], shippingCost = 0) {
    const catalog = await PricingCatalog.findOne({ key: 'storefront' }).lean();
    const productionTypes = catalog?.pricing?.SFP_PRICING_CONFIG?.productionTypes || {};
    const defaultMinimum = Number(catalog?.pricing?.SFP_PRICING_CONFIG?.defaultMinimumOrder || 50);
    const totals = {};
    const minimums = {};

    for (const item of Array.isArray(items) ? items : []) {
        const key = String(item.productionType || item.productId || item.name || 'other');
        const linePrice = moneyNumber(item.price);
        if (linePrice < 0) throw new Error('Invalid item price');
        totals[key] = (totals[key] || 0) + linePrice;
        minimums[key] = Math.max(minimums[key] || 0, Number(productionTypes?.[key]?.minimumOrder ?? item.minOrder ?? defaultMinimum));
    }

    const subtotal = Object.keys(totals).reduce((sum, key) => sum + Math.max(totals[key], minimums[key] || 0), 0);
    return { subtotal: Number(subtotal.toFixed(2)), total: Number((subtotal + Number(shippingCost || 0)).toFixed(2)) };
}

function signShippingRate(payload) {
    const secret = process.env.SHIPPING_QUOTE_SECRET || process.env.JWT_SECRET || process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) throw new Error('SHIPPING_QUOTE_SECRET is not configured');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    return `${body}.${sig}`;
}

function verifyShippingRate(token) {
    const secret = process.env.SHIPPING_QUOTE_SECRET || process.env.JWT_SECRET || process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret || !token) return null;
    const [body, sig] = String(token).split('.');
    if (!body || !sig) return null;
    const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.expiresAt || Date.now() > payload.expiresAt) return null;
    return payload;
}

async function getUpsAccessToken() {
    const clientId = process.env.UPS_CLIENT_ID;
    const clientSecret = process.env.UPS_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new Error('UPS credentials are not configured');
    const base = String(process.env.UPS_ENV || 'production').toLowerCase() === 'sandbox'
        ? 'https://wwwcie.ups.com'
        : 'https://onlinetools.ups.com';
    const response = await fetch(`${base}/security/v1/oauth/token`, {
        method: 'POST',
        headers: {
            Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: 'grant_type=client_credentials'
    });
    const data = await response.json();
    if (!response.ok || !data.access_token) throw new Error(data.response?.errors?.[0]?.message || 'UPS authentication failed');
    return { token: data.access_token, base };
}

app.post('/api/shipping/ups-rates', async (req, res) => {
    try {
        const address = req.body?.address || {};
        if (!address.city || !address.state || !address.postalCode) return res.status(400).json({ error: 'Complete shipping address required' });
        const { token, base } = await getUpsAccessToken();
        const weight = Math.max(1, Math.min(150, Number(req.body?.package?.weight || process.env.UPS_DEFAULT_WEIGHT_LBS || 5)));
        const requestBody = {
            RateRequest: {
                Request: { TransactionReference: { CustomerContext: 'SFP checkout' } },
                Shipment: {
                    Shipper: { ShipperNumber: process.env.UPS_ACCOUNT_NUMBER || undefined, Address: { PostalCode: process.env.UPS_ORIGIN_ZIP || '89118', CountryCode: 'US' } },
                    ShipTo: { Address: { AddressLine: [address.street, address.street2].filter(Boolean), City: address.city, StateProvinceCode: address.state, PostalCode: address.postalCode, CountryCode: address.countryCode || 'US' } },
                    ShipFrom: { Address: { PostalCode: process.env.UPS_ORIGIN_ZIP || '89118', CountryCode: 'US' } },
                    Package: [{ PackagingType: { Code: '02' }, PackageWeight: { UnitOfMeasurement: { Code: 'LBS' }, Weight: String(weight) } }]
                }
            }
        };
        const response = await fetch(`${base}/api/rating/v2409/Shop`, { method:'POST', headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json', transId: crypto.randomUUID(), transactionSrc:'SFP' }, body:JSON.stringify(requestBody) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.response?.errors?.[0]?.message || 'UPS rating failed');
        const rows = data?.RateResponse?.RatedShipment || [];
        const names = { '03':'UPS Ground', '01':'UPS Next Day Air', '02':'UPS 2nd Day Air', '12':'UPS 3 Day Select', '13':'UPS Next Day Air Saver', '14':'UPS Next Day Air Early', '59':'UPS 2nd Day Air A.M.' };
        const rates = rows.map(row => {
            const serviceCode = String(row.Service?.Code || '');
            const amount = Number(row.TotalCharges?.MonetaryValue || 0);
            const quote = { serviceCode, serviceName:names[serviceCode] || `UPS ${serviceCode}`, amount, currency:row.TotalCharges?.CurrencyCode || 'USD', expiresAt:Date.now()+15*60*1000 };
            return { ...quote, quoteToken: signShippingRate(quote) };
        }).filter(r => Number.isFinite(r.amount) && r.amount >= 0);
        res.json({ rates });
    } catch (error) {
        console.error('UPS rate error:', error.message);
        res.status(503).json({ error: error.message });
    }
});

app.get('/api/checkout/config', (req, res) => {
    res.json({
        zelle: {
            enabled: Boolean(process.env.ZELLE_RECIPIENT),
            recipientName: process.env.ZELLE_RECIPIENT_NAME || 'Square Foot Printing',
            recipient: process.env.ZELLE_RECIPIENT || '',
            qrUrl: process.env.ZELLE_QR_URL || ''
        }
    });
});

// -----------------------------------------------------
// CREAR ORDEN
// -----------------------------------------------------

app.post(
    '/api/place-order',

    async (req, res) => {

        try {

            const orderData =
                req.body;


            let shippingCost = 0;
            let shippingService = null;
            if (orderData.delivery_method === 'shipping') {
                const verifiedRate = verifyShippingRate(orderData.shipping_service?.quoteToken);
                if (!verifiedRate) return res.status(400).json({ success:false, error:'Shipping rate expired or invalid. Please get UPS rates again.' });
                shippingCost = Number(verifiedRate.amount);
                shippingService = verifiedRate;
            }

            const calculated = await calculateServerOrderTotal(orderData.order_items, shippingCost);
            const clientTotal = moneyNumber(orderData.total_price);
            if (Math.abs(clientTotal - calculated.total) > 0.01) {
                return res.status(409).json({ success:false, error:'Order total changed. Refresh checkout and try again.', serverTotal:calculated.total });
            }

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

                    delivery_method: orderData.delivery_method || 'pickup',
                    shipping_address: orderData.delivery_method === 'shipping' ? orderData.shipping_address : null,
                    shipping_service: shippingService,
                    shipping_cost: shippingCost,
                    payment_method: orderData.payment_method || '',
                    zelle_reference: orderData.zelle_reference || '',

                    total_price:
                        `$${calculated.total.toFixed(2)}`,

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


            sendEmail({
                to: process.env.ORDER_NOTIFICATION_EMAIL || 'orders@squarefootprinting.com',
                subject: `New Order: ${orderData.order_id}`,
                html: emailTemplate(orderData),
                replyTo: orderData.customer_email || undefined
            }).catch(
                err =>
                    console.log(
                        '❌ Resend Email Error:',
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



app.patch('/api/admin/orders/:id/tracking', authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'admin') return res.status(403).json({ msg:'No autorizado' });
        const tracking_number = String(req.body.tracking_number || '').trim();
        const carrier = String(req.body.carrier || 'UPS').trim();
        const updated = await Order.findByIdAndUpdate(req.params.id, { tracking_number, carrier, ...(tracking_number ? { status:'Shipped' } : {}) }, { new:true });
        if (!updated) return res.status(404).json({ error:'Order not found' });
        res.json(updated);
    } catch (error) { res.status(500).json({ error:error.message }); }
});

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
            const { orderDatabaseId } = req.body;
            if (!orderDatabaseId) return res.status(400).json({ error:'Missing order ID' });
            const dbOrder = await Order.findById(orderDatabaseId);
            if (!dbOrder) return res.status(404).json({ error:'Order not found' });
            const totalAmount = moneyNumber(dbOrder.total_price);
            if (!(totalAmount > 0)) return res.status(400).json({ error:'Invalid order total' });
            const request = new paypal.orders.OrdersCreateRequest();
            request.requestBody({
                intent:'CAPTURE',
                purchase_units:[{
                    reference_id: dbOrder._id.toString(),
                    custom_id: dbOrder.order_id || '',
                    amount:{ currency_code:'USD', value:totalAmount.toFixed(2) }
                }]
            });
            const order = await paypalClient.execute(request);
            res.json({ id:order.result.id });
        } catch (err) {
            console.error('PayPal create error:', err.message);
            res.status(500).json({ error:err.message });
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