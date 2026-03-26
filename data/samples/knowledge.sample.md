# Product Documentation

# API Reference

## Endpoints

* **GET** `/api/v1/users` — List all users
* **POST** `/api/v1/users` — Create a new user
* **GET** `/api/v1/users/:id` — Get user by ID

## Authentication

All API calls require a Bearer token in the `Authorization` header.

```
curl -H "Authorization: Bearer <token>" https://api.example.com/api/v1/users
```

---

# System Behavior

## User States

* **ACTIVE** — Account is active, full access
* **SUSPENDED** — Account suspended, no access
* **PENDING** — Awaiting email verification

## Billing Cycle

Monthly billing runs on the 1st of each month. Invoices are generated 3 days prior.

---

# FAQ

### Q: How do I reset a user's password?
Admin panel → Users → Select user → Reset Password. The user receives an email with a reset link.

### Q: What happens when a subscription expires?
User loses access immediately. They can resubscribe from the billing page.
