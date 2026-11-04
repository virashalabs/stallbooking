# Auto Expo Suburban Events — Stall Booking

_Since 2009_

A slot-booking app for stall events. It works like booking a movie seat: an organizer posts an event with a stall layout, vendors pick a stall, the stall is held while they pay, and the organizer confirms it.

## Run it

```bash
npm install
npm start
```

- Vendor site: http://localhost:3000
- Organizer portal: http://localhost:3000/admin.html (username **admin**, password **admin.123**; change the password under Settings)

You need Node.js 22.13 or newer. It uses the SQLite that comes with Node, so there's nothing to compile. Your data is saved in `data/`: the database is `bookmystall.db` and uploaded images go in `uploads/`.

On the first run a demo event is created from the sample layout. It has 12 stalls, and stalls 1, 6, 7 and 12 are corner stalls.

## Vendor flow

1. **Events page.** Vendors see each event's banner, date, venue, how many stalls are left and the starting price.
2. **Your details.** The vendor enters their business name, contact person, WhatsApp number and the products they'll sell.
3. **Choose a stall.** The stalls appear on top of the organizer's layout image, with a matching list below. Colours show each stall's state: available, selected, being booked, reserved, booked or corner (★). The map refreshes every 6 seconds.
4. **Reserve & pay.** The stall is **held** for a few minutes (10 by default, set in Settings) and a countdown is shown. No one else can pick a held stall. The price is the rent plus the corner charge, and the vendor gets a **UPI QR with that exact amount filled in**.
5. **I have made the payment.** The vendor can add a UTR number. The booking becomes **Reserved / pending approval** and the organizer gets a notification: *"Stall X was booked by <vendor> for the product(s) <products> and made a payment of ₹Z for the event titled <event>"*.
6. **Organizer approves.** The stall is assigned to the vendor and the vendor's page turns into a printable ticket. If the organizer rejects the booking, the stall becomes available again.

A hold that isn't paid in time expires on its own. If the vendor paid late but the stall is still free, the payment is still accepted.

## Organizer portal

- **Dashboard:** payments waiting for approval, confirmed stalls, revenue and setup reminders.
- **Events:** post an event with a banner, venue type (Corporate, Public place or Apartment), dates, **rent per stall** and an optional **extra charge for corner stalls**. You can also upload a layout image (optional).
- **Stall editor:** click to place stalls on the layout, drag to move them and drag the corner to resize. For each stall you can set the label, mark it as a ★ corner, set its own rent or block it. "Generate stalls…" creates a grid when you have no layout image.
- **Bookings:** filter by event or status. You can approve, reject, release a stall, WhatsApp the vendor, send the vendor's details to your own WhatsApp, or copy them.
- **Notifications:** a 🔔 bell that updates live.
- **Settings:** organizer name, WhatsApp number, UPI ID and payee name (used for the QR codes), hold time, an optional QR image of your own, and password.

## WhatsApp

- **Without any setup:** notifications show up in the portal. Each booking has a **Send details to my WhatsApp** button, and vendors get a **Notify organizer on WhatsApp** button after they pay. These buttons are wa.me links that open WhatsApp with the message already written.
- **Automatic sending:** set these environment variables to use the [WhatsApp Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api):

  ```bash
  WHATSAPP_TOKEN=<permanent access token>
  WHATSAPP_PHONE_NUMBER_ID=<sender phone number id>
  ```

  Payment alerts and the vendor's details (sent on approval) then go to the organizer's WhatsApp number automatically. Meta only allows free-form text messages within 24 hours of the recipient's last message to your business number. Outside that window you need an approved message template.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | 3000 | HTTP port |
| `ADMIN_PASSWORD` | admin.123 | Initial admin password (only used the first time the app runs) |
| `DATA_DIR` | ./data | Where the database and uploads are stored |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | none | Optional automatic WhatsApp messages |

## Before going live

- Put the app behind HTTPS, for example with nginx, Caddy or a host such as Render or Railway. Add `Secure` to the admin cookie in `server.js` when you do.
- Back up the `data/` folder.
- The admin portal is built for one organizer. Supporting several organizers would need user accounts and an `organizer_id` on each event.

## Hosting (Render + stall.virashalabs.online)

The app is deployed the same way as studio.virashalabs.online:

1. Push this repo to GitHub at `virashalabs/stallapp`, branch `main`.
2. In Render, choose **New → Blueprint**, pick the repo, and Render reads `render.yaml`. That creates a free web service called `stall-booking` in the Singapore region.
3. In Render, open the service and go to **Settings → Custom Domains → Add**, then enter `stall.virashalabs.online`.
4. In Namecheap, open virashalabs.online and go to **Advanced DNS**. Add a `CNAME` record with host `stall` and value `<service>.onrender.com`.

Every push to `main` redeploys the site. Add `[skip render]` to a commit message when the commit doesn't change the site.

**Free plan limits:**
- The disk is wiped on every deploy or restart. The site then starts again from `seed/`, which holds the event, layout, poster, payment QR and settings, but **bookings made on the live site are lost**.
- The site sleeps after 15 minutes with no visitors. `.github/workflows/keep-awake.yml` pings it to keep it awake.

To keep real bookings, switch to the Starter plan with a persistent disk (see the comment in `render.yaml`).

After changing the event setup locally, run `node scripts/make-seed.js` to refresh `seed/`, then commit and push.
