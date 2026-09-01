# Password Reset + Resend

Implemented:
- Nodemailer removed.
- Transactional email sent through Resend REST API.
- Login includes `Forgot your password?`.
- `forgot-password.html` provides a 3-step flow: email -> 6-digit code -> new password.
- Reset codes expire after 10 minutes.
- Codes are stored only as HMAC hashes in MongoDB.
- Maximum 5 invalid code attempts.
- Per-account resend cooldown: 60 seconds.
- Successful verification invalidates the 6-digit code and issues a short-lived password reset token.
- New passwords are hashed with bcrypt before saving.
- Existing order notification email now also uses Resend.

Required Render variables:
- `RESEND_API_KEY`
- `EMAIL_FROM=Square Foot Printing <orders@squarefootprinting.com>`
- `JWT_SECRET` (must be a strong secret)

Optional:
- `ORDER_NOTIFICATION_EMAIL=orders@squarefootprinting.com`

Test after deploy:
1. Open login and click Forgot your password?
2. Use an email that exists in MongoDB `users`.
3. Confirm a 6-digit code arrives from the configured sender.
4. Enter the code, choose a new password (8+ chars), and return to Login.
5. Sign in with the new password.
