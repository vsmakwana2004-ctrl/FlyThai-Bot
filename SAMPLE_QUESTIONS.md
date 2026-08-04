# Sample Questions for FlyThai AI Assistant

Ask these in plain English (Hindi/Hinglish input also works, but answers always come back in English). Every answer comes from a real database query, nothing is invented. Most requests are read-only lookups; the specific write actions (create, edit, status change, convert) are called out below and always ask you to confirm before saving anything.

## Quotations

- Show me the details of FTQ05260001
- How many quotations were made this month?
- List all quotations created this week
- Show quotations for agent Ranu Overseas
- Which quotations are still pending payment?

## Bookings

- What is the status of FT08261781?
- List today's upcoming bookings
- Show bookings for agent Cliq and Fly with travel status up-coming
- Which bookings have their invoice status still pending?
- Show all bookings traveling to Phuket next month
- How many bookings did Priya create this month?
- List bookings with voucher status "sent"

## Manage Hotel

- Show hotels booked for FT08261781
- What is the hotel payment status and confirmation number for FT08261780?
- Which bookings are staying at Bel Aire Patong Resort?
- Show all hotel bookings with pending payment status
- List hotels with an OTA holding status

## Job Sheet

- Show job sheet status for FT08261781
- Which job sheets still have pending vendor confirmation?
- List job sheets where lunch status is still pending
- Show job sheets assigned to a specific vehicle (e.g. "Van")

## Accounts / Account Report

- Show all pending payments
- What is the total credit and debit this month? (shown per currency)
- Show account transactions for booking FT08261781
- List all transactions for account [account name]
- Show transactions with a specific voucher number
- What is the credit, debit and balance for [hotel name] this financial year? (verified accurate for Hotel-type vendor accounts, matches the Account Master screen)
- Show recent Purchase Form / Sale Form / Bank Payment / Bank Receipt / Cash Payment / Cash Receipt transactions
- Which financial year is currently active? / List all financial years

> Note: Account balance CAN be calculated reliably for Hotel-type vendor accounts (like on the "Account Master" screen). For Bank/Cash/Credit Card accounts or the main "Account Dashboard" summary figures, the assistant will NOT calculate a balance — that depends on logic beyond the raw transaction table and isn't reliably computable this way for those account types. Check the Account Dashboard page directly for those. It can always list the raw transactions for any account regardless of type.

## Agents

- Show contact details for agent Priya
- List all agents
- How many bookings has agent [name] made?

## Inquiry

- List open inquiries assigned this week
- Show inquiry status for [guest/email]
- Which inquiries are still not closed?

## Create a New Booking or Quotation (write action)

- Create a new booking
- Start a new quotation

> Guides you through the whole real Add Booking form conversationally, step by step:
> 1. **Basic Details** (required): guest name, phone, email, agent/company, destination(s), travel & return dates. Agent and destinations are resolved against real records (asks you to disambiguate or respell if not found) — never guessed.
> 2. **Hotel** (optional): self-booked, or add one or more hotels (destination, name, check-in/out, room category, rooms, rate).
> 3. **Itinerary** (required unless self-booked, matching the real form's own rule): add Transfer, Sightseeing, and/or Restaurant items, or mark a day a Leisure Day. Pickup/drop-off points, transfer/sightseeing names, vehicle types, and restaurants are all resolved against real records.
> 4. **Price** (optional): traveller pricing lines (e.g. "Adult/Double: 8 pax at 3645 THB"), ROE rate/charge, tax, invoice discount/due date, final selling rate.
> 5. **Extra** (optional): note, emergency contact, booking by, whether the agent may download PDFs.
> 6. **Confirm**: shows a full structured summary of everything before saving — nothing is submitted to the live site until you reply "yes".
>
> Uses the real site's own `AddBooking` endpoint (same one the Add Booking page uses) — not raw SQL. You can cancel at any point by saying "cancel"/"no".

## Change Booking Status (write action)

- Change payment status of FT07261782 to done
- Set invoice status for FT08261781 to sent
- Mark voucher status as sent for FT07261782
- Update itinerary status of 261782 to created
- Change travel status of FT07261782 to on-tour

> The only write actions in this app besides booking creation. Uses the real site's own status-update endpoint (same one the Booking list page's dropdowns use), restricted to the 5 real status types (Travel/Invoice/Voucher/Itinerary/Payment) and their exact allowed values - never free text. The bot always asks you to confirm with "yes"/"no" before actually submitting the change. Doesn't apply to quotations (they don't have these statuses).

## Documents (Invoice / Itinerary / Hotel Voucher PDFs)

- Download invoice for FT08261781
- Get itinerary pdf for FT08261781
- Download hotel voucher for FT08261781

> These reply with a clickable link that opens the real PDF using your own logged-in FlyThai session. Verified safe/read-only (confirmed it doesn't change any booking status).
> Itinerary and Hotel Voucher PDFs: the bot first asks which logo version you want (With FlyThai Logo / With Agent Logo / No Logo), same as the popup on the main site - just reply with one of those, or 1/2/3. The invoice PDF has no such choice.
> Hotel Voucher: if the booking has more than one hotel stay, the bot first asks which hotel (by name and dates) before offering the logo choice.

## Edit an Existing Booking or Quotation (write action)

- Update company name of FTQ12260001 to Advance Holidays
- Set phone number of FT08261781 to 9876543210
- Change email of FTQ05260001 to abc@xyz.com
- Set guest name of FT08261781 to Mr Ramesh
- Update address of FTQ12260001 to Mumbai

> Updates one field at a time on an already-saved booking/quotation. The bot always confirms ("yes"/"no") before saving, and reads the record's current live state first so nothing else on it changes.
> Supported fields: company/agent name, phone number, email, guest name, address. Anything else (hotel details, pricing, destinations, travel/return dates) isn't editable via chat yet - use the FlyThai site directly.

- Add itinerary to FTQ12260001
- Add a transfer to FT08261781

> Walks through the same guided Transfer/Restaurant Q&A as creating a new booking (see below), but appends to an EXISTING record's itinerary instead of starting a new one - any itinerary items already saved on it are left untouched.

## Convert a Quotation to a Booking (write action)

- Convert FTQ12260001 to booking

> Checks the quotation against the real site's own requirements first (destination, guest name, company, phone, valid email, travel/return dates, at least one hotel, at least one itinerary) and lists exactly what's missing if anything is - matching the real "Convert to Booking" screen's own error messages. If everything's in place, it asks you to confirm ("yes"/"no") before converting - this cannot be undone from the chat.

## Tips

- You can ask follow-up questions in the same chat — e.g. ask about a booking, then just say "and its payment status?"
- Use "New Chat" to start a fresh conversation if you want to reset context.
- If an answer looks wrong, tell the assistant exactly what you asked so it can be checked against the actual SQL query it ran.

## Not yet available in chat

- Editing hotel details, pricing/member details, destinations, or travel/return dates on an existing booking/quotation — the field-edit feature above only covers company/phone/email/guest name/address.
- Editing or removing an itinerary item that's already been added — you can only add new ones.
- Hotel extra-charge attributes (extra bed/meals) — add those afterwards in the Booking panel.
- Account Dashboard summary balances, and balances for non-Hotel account types (Bank/Cash/Credit Card) — see note above.

For anything in this list, use the FlyThai site directly.
