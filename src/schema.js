// Curated, human-written description of the FlyThai database schema.
// This is given to the LLM as context so it can write correct T-SQL (SQL Server) queries.
// Keep it accurate to the real DB — update if the schema changes.

const SCHEMA_DOC = `
DATABASE: arkinfo1_flythai (Microsoft SQL Server). All queries MUST be plain T-SQL SELECT statements only.

=== BookingMaster ===  (the central table: holds BOTH quotations and confirmed bookings)
Columns: Id(int PK), BookingId(varchar, format like 'FT08261781' - set only when IsBooking=1), QuotationId(varchar, format like 'FTQ05260001' - set only when IsBooking=0), IsBooking(bit: 0=this row is a QUOTATION, 1=this row is a confirmed BOOKING), Destinations(varchar, comma-separated Destination.Id values e.g. '3' or '4,3'), GuestName, GuestPhoneNumber, GuestEmail, GuestCompany, GuestAddress, GuestAdults(int), GuestChildrens(int), GuestInfants(int), AgentId(int FK -> Agents.Id), TravelDate(date), ReturnDate(date), Currency, ROERate, TaxAmount, TaxPercentage, TravelStatus(EXACT values only: 'up-coming', 'on-tour', 'booking-cancelled', 'closed' - there is no plain 'cancelled', a cancelled trip is 'booking-cancelled'; reproduced live: "which bookings are cancelled" filtered TravelStatus = 'Cancelled' and wrongly found none, when 22 real rows have 'booking-cancelled'), InvoiceStatus(e.g. 'pending'), VoucherStatus, ItineraryStatus, PaymentStatus, BookingBy(varchar, staff member name who made it), CreatedOn(datetime WITH time - when the row was created; this is what the site's list screens label "BOOKING DATE", and it is NOT the travel date), UpdatedOn(datetime WITH time), IsDelete(bit - ALWAYS filter IsDelete=0), LandSelling(decimal), InvoiceDiscount.
IMPORTANT: "FTQ..." codes = Quotation ID (search QuotationId column). "FT..." codes (no Q) = Booking ID (search BookingId column). The user may just say "FT number" meaning either — if unsure which, check both columns.
If the user gives only a bare number or a partial/short number WITHOUT the "FT"/"FTQ" prefix (e.g. "261781" instead of the real code "FT08261781"), do NOT assume it's the whole code minus the prefix and reconstruct it as 'FT261781' - that will likely not match, since real codes have extra digits in the middle (month/etc). Instead use a partial match: bm.BookingId LIKE '%261781%' OR bm.QuotationId LIKE '%261781%' (matches the digits appearing anywhere in the real code).
The int Id column here is the internal primary key referenced as "BookingId" (an INT foreign key) in most other tables below (BookingHotel, BookingItineary, JobSheetMaster, AccountTransaction, HotelMaster, PaymentMaster, etc.) — do not confuse it with the varchar BookingMaster.BookingId code (e.g. 'FT11261760').
NEVER strip "FT"/"FTQ" from a code and treat the remaining digits as if they were BookingMaster.Id or a related table's BookingId — they are NOT the same number (e.g. 'FT11261760' does NOT mean Id=11261760). This is a real mistake seen before: writing "WHERE bh.BookingId = 11261760" is WRONG. The ONLY correct way to query a related table (BookingHotel, JobSheetMaster, etc.) by a code like 'FT11261760' is to JOIN through BookingMaster first: "FROM BookingHotel bh JOIN BookingMaster bm ON bh.BookingId = bm.Id WHERE bm.BookingId = 'FT11261760'" — always resolve the code to bm.Id via a join/subquery, never guess or derive it from the code's digits.

=== Agents === (travel agents who book on behalf of guests)
Columns: Id(int PK), Name, Phone, Email, Address, IsDeleted(bit - filter =0). Joined via BookingMaster.AgentId = Agents.Id.
Some real agent names START WITH A NUMBER (e.g. "99 HOLIDAYS", "1 Stop Travels") - that leading number is part of the NAME text, never the internal Agents.Id. Always match the whole phrase against Name (a.Name LIKE '%99 HOLIDAYS%' or = '99 HOLIDAYS'), never split off the leading digits and filter Agents.Id by them. Reproduced live: "show contact details for agent 99 HOLIDAYS" queried WHERE Id = 99 AND Name LIKE '%HOLIDAYS%' and found nothing, when the real agent (Id 222, unrelated to "99") is named exactly "99 HOLIDAYS".

=== Destination === Id(int PK), Name, ShortCode, IsDelete(bit). BookingMaster.Destinations is a comma-separated list of Destination.Id (e.g. '4,3') — it is NEVER a single exact id, so never join with "bm.Destinations = CAST(d.Id AS VARCHAR)" (that only matches single-destination bookings and silently returns NULL/no name for multi-destination ones). Instead use: LEFT JOIN Destination d ON CHARINDEX(',' + CAST(d.Id AS VARCHAR) + ',', ',' + bm.Destinations + ',') > 0 AND d.IsDelete = 0, then STRING_AGG(d.Name, ', ') to combine them per booking.
CRITICAL — that join matches ONE ROW PER DESTINATION, so a trip covering 4 destinations comes back as 4 identical-looking booking rows unless you collapse it. A plain "LEFT JOIN Destination ... " with no GROUP BY / STRING_AGG silently turns a 3-booking answer into 7 rows. This has actually happened. When listing bookings/quotations, NEVER leave that join un-aggregated. Prefer this self-contained form, which cannot multiply rows and needs no GROUP BY:
  FROM BookingMaster bm
  CROSS APPLY (SELECT STRING_AGG(d.Name, ', ') AS DestinationList
               FROM Destination d
               WHERE CHARINDEX(',' + CAST(d.Id AS VARCHAR) + ',', ',' + bm.Destinations + ',') > 0
                 AND d.IsDelete = 0) AS DestList
The same warning applies to LEFT JOIN BookingHotel / BookingItineary / AccountTransaction in a LIST query: each returns many rows per booking. In a query that lists bookings, one output row must mean one booking — aggregate or use CROSS APPLY, never a bare LEFT JOIN.
"Which bookings are going to/visiting <destination>" needs BOTH a filter (does this booking include that one destination) AND a full destination list to display - use exactly this shape (a WHERE EXISTS for the filter, the CROSS APPLY above for the display list, JOINs before WHERE, never after):
  SELECT bm.BookingId, bm.GuestName, DestList.DestinationList
  FROM BookingMaster bm
  CROSS APPLY (SELECT STRING_AGG(d.Name, ', ') AS DestinationList
               FROM Destination d
               WHERE CHARINDEX(',' + CAST(d.Id AS VARCHAR) + ',', ',' + bm.Destinations + ',') > 0
                 AND d.IsDelete = 0) AS DestList
  WHERE bm.IsDelete = 0 AND bm.IsBooking = 1
    AND EXISTS (SELECT 1 FROM Destination d2 WHERE d2.Name = '<destination>' AND d2.IsDelete = 0
                AND CHARINDEX(',' + CAST(d2.Id AS VARCHAR) + ',', ',' + bm.Destinations + ',') > 0)
Reproduced live twice on this exact question shape: once with a JOIN placed after the WHERE clause (a syntax error - all JOINs/CROSS APPLYs must come before WHERE), once with "d.IsDeleted" instead of the real column "d.IsDelete" on Destination. Double-check both before finalizing this kind of query.
COMPOUND JOIN TRAP - worse than the single-join case above: joining BookingHotel AND BookingItineary (or BookingItineraryRestaurant) together in the same query multiplies rows AGAINST EACH OTHER, not just against BookingMaster - 2 hotels × 9 itinerary items becomes 18 rows for ONE booking, not 11. Reproduced live: "give me info about guest X" (one guest, 2 real bookings) returned 20 raw rows because both tables were joined together unaggregated - the answer text correctly said "2 bookings" but the underlying row data looked like 20 different records. When a question needs a per-booking summary touching hotel and/or itinerary details, aggregate EACH one-to-many table separately via its own CROSS/OUTER APPLY (same idea as the Destination example above) - never let BookingHotel and BookingItineary sit in the same FROM/JOIN chain together:
  FROM BookingMaster bm
  OUTER APPLY (SELECT STRING_AGG(Name, ', ') AS HotelList FROM BookingHotel WHERE BookingId = bm.Id AND IsDelete = 0) AS h
  OUTER APPLY (SELECT STRING_AGG(Particular, ', ') AS ItineraryList FROM BookingItineary WHERE BookingId = bm.Id AND IsDelete = 0) AS it
This returns exactly one row per booking no matter how many hotels or itinerary items it has.

=== BookingHotel === (hotels booked for a trip/itinerary)
Columns: Id, BookingId(int FK -> BookingMaster.Id), DestinationId(FK->Destination.Id), HotelId(FK->Hotel.Id), Name(hotel name text), RoomCategory, TotalRooms, TotalNights, CheckInDate, CheckOutDate, Rate, ConfirmationId, HotelRatePerNight, HotelRatePerNightCurrency, TotalAmount, IsDelete(bit).
IMPORTANT: TotalAmount already includes any extra charges below - it is the final correct total. But if the user asks for "hotel details" or a cost breakdown, you MUST also check BookingHotelAttributeMapping (join on BookingHotelId = BookingHotel.Id) for extra add-on charges included in that total - e.g. extra bed, extra breakfast, extra lunch/dinner - and list them, otherwise the answer looks incomplete compared to the real booking (this has been missed before - always check this table when showing hotel cost breakdowns).
"Total hotel cost" for a BOOKING, or for an AGENT/COMPANY across their bookings (e.g. "total hotel cost for Ajay Modi Travels this month") means SUM(BookingHotel.TotalAmount) — join BookingHotel to BookingMaster (and BookingMaster.AgentId to Agents for the company filter). Do NOT compute this from AccountTransaction/AccountMaster (see the warning in that section below) - reproduced live: filtering AccountMaster by both the agent's own Name AND AccountType='Hotel' matches nothing, since an agent's account row and a hotel vendor's account row are different rows entirely, so that query silently returns zero every time.
"Hotel [rate/price/amount] ... of/for <name>" where <name> is a GUEST (not a real hotel property name from the Hotel table) means: find that guest's booking (BookingMaster.GuestName LIKE '%<name>%'), then join BookingHotel on BookingId = BookingMaster.Id to get ITS HotelRatePerNight - never search the Hotel master table's own Name column for the guest's name. Reproduced live: "what is hotel per night amount of cb" (a guest, per BookingMaster.GuestName = 'cb') searched Hotel.Name LIKE '%cb%' instead and found nothing, when the real answer was sitting in that guest's own BookingHotel row.

=== BookingHotelAttributeMapping === (extra/optional charges added to a hotel booking - e.g. extra bed, extra breakfast, extra meals)
Columns: Id, AttributeTypeId(FK->AttributeType.Id), BookingHotelId(FK->BookingHotel.Id), Adults(int, how many people this charge is for), Children, Infants, Price(decimal, per-person/per-night rate), FinalPrice(decimal, the actual total charged for this line item), Currency, IsDeleted(bit), IsActive(bit).
=== AttributeType === Id, Type(e.g. 'Extra bed for adult', 'Extra breakfast for adult', 'Extra bed for Child', 'Extra Lunch for Adult', 'Extra Dinner for Adult', etc.), AllowedForAdult(bit), AllowedForChild(bit), AllowedForInfant(bit), IsDelete(bit), IsActive(bit).

=== HotelMaster === (hotel booking confirmation/payment status - ONE ROW PER HOTEL, not per booking)
Columns: Id, BookingId(int FK->BookingMaster.Id), HotelId(int - DESPITE THE NAME this is actually a FK -> BookingHotel.Id, NOT Hotel.Id - verified against real data), IsOTA(bit - which column set below is the real one for this row), Currency, ROE, IsConfirm(bit), IsDelete(bit).
Every real-world field on this table exists as a PAIR of columns - one for a direct hotel booking, one for a booking made through an OTA (online travel agency, e.g. REZLIVE) - and IsOTA says which half is actually populated for that row. The OTHER half is NULL, not zero/empty, so a query that only ever reads the Hotel* column silently gets NULL/no-match for every OTA-booked hotel, even though the real value exists right there in the Ota* column (reproduced live: HotelDeadline was NULL and OtaDeadline='2026-08-10' on the exact same row, and HotelMaster.Id=433's real confirmation number '6A687622' only exists in OtaConfirmationId - a query filtering ConfirmationId/HotelConfirmationId alone found nothing for a real, correct number). The pairs:
  HotelHolding / OtaHolding, HotelDeadline / OtaDeadline, HotelIsFinalConfirm / OtaIsFinalConfirm, HotelVoucher (no Ota equivalent), HotelPaymentStatus / OtaPaymentStatus, HotelConfirmationId / OtaConfirmationId, HotelRate / OtaRate, HotelRateCurrency / OtaRateCurrency, HotelPaidOn / OtaPaidOn, HotelRemarks / OtaRemarks, HotelPaymentSpecification / OtaPaymentSpecification.
For ANY question about a hotel's deadline/rate/holding/confirmation number/payment status/paid date/remarks - unless the user is explicitly asking only about OTA or only about direct-hotel bookings - read BOTH columns of the relevant pair with COALESCE (e.g. COALESCE(HotelDeadline, OtaDeadline) AS Deadline) or an OR in a WHERE clause (e.g. WHERE HotelConfirmationId = @num OR OtaConfirmationId = @num), never just the Hotel* one alone. Also note BookingHotel.ConfirmationId is a THIRD, separate confirmation-number field on a different table - a confirmation-number search should check all three (BookingHotel.ConfirmationId, HotelMaster.HotelConfirmationId, HotelMaster.OtaConfirmationId).
CRITICAL: A booking can have MULTIPLE hotels (multiple BookingHotel rows), each with its own HotelMaster confirmation/payment row. To get the right confirmation/payment status for a SPECIFIC hotel stay, join HotelMaster.HotelId = BookingHotel.Id (per-hotel), NEVER just HotelMaster.BookingId = BookingMaster.Id alone when BookingHotel is also joined - that produces a cross-product of every hotel × every HotelMaster row for that booking (wrong, duplicated data). If you only need BookingId-level info without per-hotel detail, joining on BookingId alone is fine, but be aware one booking may have several HotelMaster rows (one per hotel).
When LISTING hotel/OTA payment (or holding/deadline/confirmation) status across multiple bookings - e.g. "list of hotel payment status pending", "which OTA payments are pending" - NEVER select HotelMaster's own raw Id/BookingId/HotelId columns, they are meaningless to staff (internal PKs, and BookingId here is an int, not the real "FT.../FTQ..." code). Always join back through BookingHotel and BookingMaster so the answer shows the real booking code and hotel name instead:
  FROM HotelMaster hm
  JOIN BookingHotel bh ON hm.HotelId = bh.Id
  JOIN BookingMaster bm ON bh.BookingId = bm.Id
  WHERE hm.IsDelete = 0 AND bh.IsDelete = 0 AND bm.IsDelete = 0 AND hm.IsOTA = 0/1 (match whichever the question asked about, or omit to cover both)
Select COALESCE(bm.BookingId, bm.QuotationId) AS Code, bh.Name AS HotelName, plus the relevant Hotel*/Ota* status column(s) - never hm.Id, hm.BookingId, or hm.HotelId themselves.

=== Hotel === (hotel master directory) Id(PK), Name, PhoneNumber, Address, Destination(FK->Destination.Id), Email, RatePerNight, RatePerNightCurrency, IsDelete(bit).
=== HotelRoomType === Id, HotelId(FK->Hotel.Id), RoomName, RatePerNight, Currency, IsActive, IsDelete.

=== BookingItineary === (day-by-day itinerary / activities for a trip)
Columns: Id, BookingId(int FK->BookingMaster.Id), Date, Time, Particular(activity/place name), Type, PickupPointId(FK->Pickup.Id), VehicleType, FinalPrice, TotalAdult, TotalChild, TotalInfant, FlightNo, IsDelete(bit).
A booking's pickup point ONLY exists here (BookingItineary.PickupPointId -> Pickup.Id) - neither BookingMaster nor BookingHotel has any pickup-related column at all. For "what is the pickup point for <booking>", join BookingMaster -> BookingItineary -> Pickup through PickupPointId; never guess a PickupId column on BookingMaster/BookingHotel, it doesn't exist there.

=== BookingItineraryRestaurant === Id, BookingId(int FK->BookingMaster.Id), RestaurantId(FK->RestaurantMaster.Id), Date, AdultsForLunch, ChildrenForLunch, AdultsForDinner, ChildrenForDinner, FinalPrice, IsDelete(bit).

=== BookingMemberType === Id, BookingId(int FK->BookingMaster.Id), Type, Price, PAX, IsDelete(bit). (pricing per traveler type)

=== JobSheetMaster === (operations job sheet — vendor/vehicle/meal dispatch status for each itinerary line item)
Columns: Id, BookingId(int FK->BookingMaster.Id), ItineraryId(FK->BookingItineary.Id, nullable), ItineraryRestaurantId(FK->BookingItineraryRestaurant.Id, nullable), VendorName, BookingSentStatus, CustomerSentStatus, LunchStatus, DinnerStatus, VehicleName, GeneralRemarks, Status(overall status), IsDelete(bit).
A row links to EXACTLY ONE of ItineraryId (transfer/sightseeing) or ItineraryRestaurantId (meal/restaurant, e.g. "Dinner Coupon") - never both, never neither (verified against the full table). A query that needs this row's own DATE (e.g. "job sheets/pickups on <date>") must LEFT JOIN both BookingItineary and BookingItineraryRestaurant and match either one's Date - joining only BookingItineary silently drops every meal-type job sheet from date-scoped results (reproduced live: undercounted a real day's job sheets by exactly its Dinner Coupon entries).
Any job sheet listing shown to staff MUST JOIN BookingMaster bm ON jsm.BookingId = bm.Id AND bm.IsDelete = 0 (an INNER join, not LEFT - jsm.BookingId is always set, and a job sheet whose booking was later deleted is not something staff should see in an operational list) and SELECT COALESCE(bm.BookingId, bm.QuotationId) as the "Booking ID" column - NEVER show jsm.Id or the raw jsm.BookingId int as the Booking ID, those are internal database keys meaningless to staff. Reproduced live: (1) a job sheet query with no BookingMaster join showed staff raw internal values like "1385"/"1391" labeled "Booking ID" instead of the real FT.../FTQ... code; (2) a later fix that LEFT JOINed BookingMaster without requiring bm.IsDelete = 0 in the WHERE still let dozens of job sheets belonging to deleted bookings through, showing blank Booking ID/Guest Name instead of being excluded.
Any job sheet listing must SELECT the FULL set of columns the answer table needs - bm.GuestName, jsm.VendorName, the row's own Date (per the dual-join rule above), jsm.BookingSentStatus, jsm.CustomerSentStatus, jsm.LunchStatus, jsm.DinnerStatus - even when the question only names ONE of these (e.g. "lunch status pending"). Selecting only the one column the question named leaves every other column blank in the answer even though real data exists for them. Reproduced live: a "job sheets with lunch status pending" query selected only LunchStatus, so Vendor Confirmation/Customer Update/Dinner Status/Travel Date all showed blank despite having real values in the database.

=== AccountMaster === (chart of accounts / ledger accounts — e.g. hotels, vendors, agents as accounts)
Columns: Id(PK), AccountGroupId(FK->AccountGroup.Id), AccountType(values seen: 'Hotel', 'Agent', 'Vender', 'OfficeExpense', 'Salary', or NULL), Name, AccountNo, Mobile, Email, Address, City, State, Country, OpeningBalance, Currency, IsActive(bit).
An AGENT and a HOTEL are always two SEPARATE rows here (one AccountType='Agent', the others AccountType='Hotel') - never filter a single AccountMaster row by both an agent's Name AND AccountType='Hotel' (or vice versa), that matches nothing. For "how much has agent X been charged for hotels" style questions, don't use AccountMaster/AccountTransaction at all - see BookingHotel.TotalAmount above, which is the correct, simpler source for hotel cost.
=== AccountGroup === Id(PK), Name, GroupType, IsActive.

=== AccountTransaction === (ledger transactions / payments — the core accounting table)
Columns: Id(PK), VoucherNo, TransactionDate, BookingId(int FK->BookingMaster.Id, nullable), AccountId(FK->AccountMaster.Id), TransactionAmount(decimal), TransactionType('Credit' or 'Debit'), Currency, ROE, Remark, TransactionFor(values seen: 'Bank Payment', 'Bank Receipt', 'Cash Payment', 'Cash Receipt', 'Purchase Form', 'Sale Form', 'Opening Balance' — this is what the site's "Transaction" menu filters by), InvoiceNo, JobSheetId(FK->JobSheetMaster.Id, nullable), IsDeleted(bit - filter =0).

ACCOUNT BALANCE (Credit/Debit/Balance) — read carefully, this was verified empirically against the real app, twice:
- For a **Hotel-type vendor account** (AccountMaster.AccountType='Hotel'), on the site's "Account Master" screen (filtered to one Financial Year's date range), the displayed columns are: UI "CREDIT" = SUM(TransactionAmount) WHERE TransactionType='Debit', UI "DEBIT" = SUM(TransactionAmount) WHERE TransactionType='Credit', UI "BALANCE" = (that Debit-sum) - (that Credit-sum). Yes, the UI's Credit/Debit column labels are the OPPOSITE of the raw TransactionType value — verified against 5 real accounts, exact match to the cent. If asked for a hotel/vendor account's balance for a given financial year, you may compute it this way, filtering TransactionDate to that FinancialYear's StartDate/EndDate (join FinancialYear, or use the active one — IsActive=1 — if no year is specified), and clearly present it as "Credit / Debit / Balance" matching the site's own labels (i.e. already swapped per this formula, don't swap again).
- When the question names a HOTEL PROPERTY (e.g. "credit debit balance for Grand Mercure Bangkok Atrium"), that hotel's AccountMaster row is found by matching its NAME string - AccountMaster.Name = '<hotel name>' AND AccountMaster.AccountType = 'Hotel' - directly, with NO join to the Hotel table needed or correct at all. AccountMaster.Id and Hotel.Id are unrelated primary keys from two different tables that happen to both be called "Id" - they do NOT refer to the same row, so "JOIN Hotel h ON h.Id = am.Id" silently matches the wrong (or no) row. Reproduced live: exactly that join returned zero rows for a hotel that has real transactions, because AccountMaster.Id for that hotel and Hotel.Id for that hotel are two different numbers that happened not to collide.
- For any OTHER account type (Bank, Cash, Credit Card, Agent, etc.) or for the summary figures on the main "Account Dashboard" page — DO NOT compute a balance. It is verified NOT reliable there (e.g. account "TBO" nets to 0 from its own transactions but the real dashboard shows a non-zero balance for it) — some depend on business logic outside this table. Say balance isn't reliably computable for that account type and suggest checking the relevant page directly.
- You CAN and SHOULD always answer questions about the raw transaction list itself (e.g. "show transactions for account X", "list payments for booking Y", "show Purchase Form transactions this month") since that's just reading real rows, not a derived calculation.

=== PaymentMaster === Id, BookingId(int FK->BookingMaster.Id), PaymentStatus, PaidAmount, Currency, IsDelete(bit).
=== ReceivableMaster === Id, BookingId(int FK->BookingMaster.Id), Type, Name, Currency, Value, JobsheetId, VendorName, IsDelete(bit).
=== FinancialYear === Id, StartDate, EndDate, DisplayFinYear, IsActive.

=== Inquiry === (pre-sales customer inquiries, may later convert into a BookingMaster row)
Columns: Id, EmailId, MailSubject, MailBody, ReceivedDateTime, FromDate, ToDate, NoOfPersons, Destination(text), Remarks, AssignedUserId, StatusId(FK->InquiryStatus.Id), IsClosed(bit), AgentId(FK->Agents.Id), BookingId(FK->BookingMaster.Id, nullable), PhoneNo, IsDeleted(bit).
RULE - "closed" inquiries: use Inquiry.IsClosed=1 directly, NEVER InquiryStatus.StatusName='Closed' - that status value does not exist in InquiryStatus (real values are Assigned/Canceled/Converted/Follow-Up/New/On Hold/Quotation Created/Rejected; a closed inquiry's StatusName is typically 'Converted', not 'Closed'). Reproduced live: joining on StatusName='Closed' silently returned 0 rows while the real count via IsClosed=1 was 3.
=== InquiryStatus === Id, StatusName, IsFinalStatus.
=== InquiryTaskLog === Id, InquiryId(FK->Inquiry.Id), BookingId, FollowUpType, Remarks, CreatedOn.

=== Pickup === Id, Name, Destination(text), HotelId, IsDelete.
=== VehicalMaster === Id, Name, Capacity, IsActive, IsDeleted.
=== TransferVehicalMapping === Id, TransferId, VehicalId(FK->VehicalMaster.Id), Price, Currency, IsActive, IsDeleted.
=== RestaurantMaster === Id, Name, PhoneNumber, Address, Destination(FK->Destination.Id), LunchPriceForAdults, DinnerPriceForAdults, IsDelete.
=== RoomPricing === Id, RoomId(FK->HotelRoomType.Id), FromDate, ToDate, Price, IsActive, IsDelete.
=== Particular === Id, Name, Destination(text), AdultsPrice, ChildrenPrice, Currency, Category, IsDeleted.
=== ConversionMaster === Id, FromDate, ToDate, THBPrice, USDPrice (currency conversion rates).

GENERAL RULES FOR WRITING SQL:
- Always filter out soft-deleted rows: use "IsDelete = 0" or "IsDeleted = 0" (check the exact column name per table above — some tables use IsDelete, some IsDeleted).
- The word "booking(s)" in a question about BookingMaster (or its child tables), WITHOUT the word "quotation(s)" also appearing, means the query MUST filter bm.IsBooking = 1. The word "quotation(s)" alone (without "booking(s)") means bm.IsBooking = 0. Add this filter explicitly - never rely on it happening implicitly through some other filter, and never answer "bookings" with a query that has no IsBooking filter at all. Reproduced live: "which bookings are travelling this month" and "bookings for sanskar" both had no IsBooking filter, so a genuine quotation (IsBooking = 0) appeared in the answer as if it were a confirmed booking.
- Prefer TOP 50 unless the user clearly wants an aggregate/count/sum. BUT when the user asks for ALL matching records ("all bookings", "every quotation", "provide me all ..."), use TOP 300 instead — TOP 50 silently caps the result, and the answer then reports 50 as if it were the true total when there are more.
- Any query listing rows from a detail/child table where EACH ROW is its own separate real record (job sheets, itinerary items, transactions, payments, etc. — as opposed to a parent-table listing like bookings, where a join fan-out SHOULD be collapsed per the Destination rule above) MUST include that table's own Id column in the SELECT list, even though it will never be shown to the user. Without it, two genuinely different records that happen to display identical values in every OTHER selected column look byte-identical downstream and get silently collapsed into one - undercounting the true total. Reproduced live: a "job sheets with lunch status pending" query with no JobSheetMaster.Id in its SELECT fetched 50 real, distinct job sheets, but 15 of them displayed identically (same booking, same date, same blank vendor, same "Pending" statuses) and were merged away, reporting "35 total" when 1,779 really matched.
- Use LEFT JOIN to Agents / Destination / Hotel / AccountMaster etc. when the user wants readable names instead of raw IDs.
- When a WHERE clause filters on a date/period (TravelDate, CreatedOn, etc.), also include that same column in the SELECT list. Without it, whoever reads the results has no way to see which date justified each row, and may wrongly re-filter by a different date column that IS visible (e.g. filtering by CreatedOn but only selecting TravelDate led the answer to wrongly drop rows whose TravelDate fell outside the period, even though they were correctly matched by CreatedOn).
- Dates are SQL 'date'/'datetime' — use CONVERT/FORMAT for display comparisons; compare using >=, <=. NEVER use GETDATE()/CAST(GETDATE() AS date) for "today" - the database SERVER runs in a different timezone (verified: it can be a full calendar day behind IST), so GETDATE() silently answers about the wrong day. "Today's date is ..." is already given to you above the schema - use that literal date (e.g. bm.TravelDate = '2026-08-05'), never GETDATE().
- ONE DATE vs A RANGE — decide by the preposition, and be consistent (the same wording must always produce the same filter):
  * "FROM <date>" with no end date means ON OR AFTER that date: bm.TravelDate >= '2026-08-02'. "from 02-Aug-2026", "starting 02-Aug-2026", "onwards from 02-Aug-2026", "on or after", "after", "since" — all of these are open-ended ranges, NOT a single day. Do not narrow them to one date.
  * "ON <date>", "OF <date>", "<date> this date", or a bare date with no preposition means THAT EXACT DAY: bm.TravelDate = '2026-08-02'.
  * "FROM <date> TO <date>", "BETWEEN X AND Y" means a closed range: >= X AND <= Y.
  * "BEFORE <date>", "UP TO <date>", "TILL <date>" means <= (or < for "before").
  Always word the answer so the interpretation is visible — say "travelling on or after 02-Aug-2026" for a range and "travelling on 02-Aug-2026" for a single day, so the user can see which reading was used.
- DATE LITERALS: when the user names a specific date in ANY format ("02-Aug-2026", "2-8-2026", "2 August 2026", "02-Aug-2026 this date"), convert it to an ISO literal and use it directly: bm.TravelDate = '2026-08-02'. Same for "today"/"now"/"tonight" - use the literal "Today's date is ..." value given above (as an ISO literal), and add/subtract 1 day from THAT literal for "tomorrow"/"yesterday". NEVER use GETDATE() for any of this (see the GETDATE() warning above) - that silently answers about the wrong day. A trailing "this date"/"is date"/"on this date" is just filler referring to the date already given in the same sentence, not a request for today.
- WHICH DATE COLUMN: BookingMaster.TravelDate is the date the trip departs, and it is the column the site's own Booking list "From Date"/"To Date" filter uses. A question that names a date without saying which date it means ("bookings on 02-Aug-2026", "booking list of 2 August", "who is travelling tomorrow") ALWAYS means TravelDate. Use CreatedOn ONLY when the user explicitly says the record was created/made/entered/added/done/booked on that date, OR when the question is about a staff member's booking activity over a period ("booking done by priya in july", "how many bookings did priya make last month") - that's asking when Priya DID the booking (the site's own "BOOKING DATE" column), not when the guest travels. Reproduced live: "list of booking done by priya in july" filtered on TravelDate and returned only 10 rows, when 25 bookings actually have BookingBy='Priya' and CreatedOn in July - the site's own Booking list shows exactly those 25 under its "BOOKING DATE" column. Never pick the date column based on what an earlier answer in the conversation happened to mention.
- CreatedOn / UpdatedOn are datetime values WITH a real time component (e.g. 2026-07-29T06:57:26.580). Comparing them to a bare date with "=" matches only rows stored at exactly midnight, so it silently returns zero rows even on days that do have records. Always wrap them: CAST(bm.CreatedOn AS date) = '2026-08-02'. TravelDate and ReturnDate are pure 'date' columns, so a plain "=" is correct for those.
- Names (agents, hotels, guests, destinations) can themselves contain common words like "and"/"the" (e.g. an agent literally named "Cliq and Fly"). When the user gives a single name phrase, match it as ONE value with LIKE '%whole phrase%' — do NOT split it into multiple separate names/an IN-list just because it contains a word like "and", unless the user clearly separates multiple distinct names with a comma or "or".
- A bare person's name in a booking/quotation question WITHOUT the word "for" or "of" (e.g. "Priya's bookings", "show me Ranu booking", "booking done by Priya") is AMBIGUOUS — it could be the GUEST (BookingMaster.GuestName), the AGENT (Agents.Name via AgentId), or the STAFF MEMBER who created it (BookingMaster.BookingBy — e.g. "Priya", "Nidhi", "Dhruman" are staff names, not guests or agents). ALWAYS search ALL THREE with OR: (bm.GuestName LIKE '%X%' OR a.Name LIKE '%X%' OR bm.BookingBy LIKE '%X%') — do NOT narrow to a single field even when the phrasing sounds specific ("booked by X", "done by X", "who made X"); that wording is meant to steer toward BookingBy but is too easy to misparse as "the guest is X" instead, and missing real rows (a false negative) is a worse failure than including one extra unrelated row. Reproduced live: "list of booking done by priya in july" was answered "no bookings found" because only GuestName got searched, when Priya is actually the staff member (BookingMaster.BookingBy) who made 20+ real bookings that month.
- "booking(s)/quotation(s)/hotel/cost/... FOR <name>" or "... OF <name>" is NOT ambiguous the way the rule above is - "for"/"of" specifically names the GUEST, never the agent, staff member, or (for a hotel question) the Hotel master table's own name. Search bm.GuestName ONLY (bm.GuestName LIKE '%X%'), not Agents.Name, not BookingBy, not Hotel.Name. Reproduced live: (1) "bookings for sanskar" searched GuestName OR Agents.Name OR BookingBy like the ambiguous case above, and returned rows where the AGENT was "sanskar travels" or the staff member was "sanskar" even though no guest is actually named Sanskar; (2) "hotel per night amount of cb" (cb is a guest, BookingMaster.GuestName='cb') searched the Hotel master table's Name column instead and found nothing.
- Money columns can be in different currencies (Currency column next to each amount). NEVER SUM or AVERAGE a money column across rows without also GROUP BY the Currency column — adding THB and INR amounts together produces a meaningless number. Always show/group totals per currency (e.g. "SUM(TransactionAmount) ... GROUP BY Currency"), and include the currency column in results when showing amounts.
- Never write INSERT/UPDATE/DELETE/DROP/ALTER/EXEC or any statement other than a single SELECT — you are strictly read-only.
- When the user broadly asks for a booking's/quotation's "details", "full details", "all details", or just "share/give me info about X" (without narrowing to one specific area like just payments or just job sheet), that means give a COMPLETE picture like the real Invoice/Itinerary PDF would show — not just the bare BookingMaster row. In that case ALSO pull hotel info (LEFT JOIN BookingHotel, and BookingHotelAttributeMapping for any extra charges) and a short itinerary summary (LEFT JOIN BookingItineary), not just guest/status fields. Only skip these extra joins if the user's question is clearly narrow (e.g. explicitly just asks about payment status or just job sheet status).
`;

// --- Two-tier schema retrieval (keeps the full per-table detail above as the ONE source of truth,
// never hand-duplicated) ---
// SCHEMA_DOC above is large (every table's columns plus every "reproduced live" correctness rule),
// and sending all of it on every single LLM call is what was driving request sizes up toward - and
// past - the smallest fallback model's own token-per-minute budget. Splits it, by parsing the SAME
// string above (so editing SCHEMA_DOC is still the only thing anyone ever needs to do - both views
// derive from it automatically, they cannot drift apart):
//   - a compact TABLE_OVERVIEW (table name + one-line summary, always cheap enough to send)
//   - buildSchemaDoc(tableNames) - the FULL detail for just the requested tables, plus GENERAL_RULES
//     (always included in full - those rules are cross-cutting, not tied to one specific table)
// The Understand step reads TABLE_OVERVIEW and says which tables a question needs; the Planner step
// then only gets those tables' full detail instead of every table's.
const GENERAL_RULES_MARKER = 'GENERAL RULES FOR WRITING SQL:';
function parseSchemaDoc(raw) {
  const generalIdx = raw.indexOf(GENERAL_RULES_MARKER);
  const body = generalIdx === -1 ? raw : raw.slice(0, generalIdx);
  const generalRules = (generalIdx === -1 ? '' : raw.slice(generalIdx)).trim();
  const headerRe = /^=== *(\w+) *===/gm;
  const matches = [...body.matchAll(headerRe)];
  const preamble = (matches.length ? body.slice(0, matches[0].index) : body).trim();
  const tables = {};
  const order = [];
  for (let i = 0; i < matches.length; i++) {
    const name = matches[i][1];
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : body.length;
    const text = body.slice(start, end).trim();
    if (!(name in tables)) order.push(name);
    tables[name] = name in tables ? `${tables[name]}\n\n${text}` : text;
  }
  return { preamble, tables, order, generalRules };
}

const { preamble: SCHEMA_PREAMBLE, tables: TABLE_DETAILS, order: TABLE_NAMES, generalRules: GENERAL_RULES } = parseSchemaDoc(SCHEMA_DOC);

// Hand-written one-line summary per table (the only new hand-authored content here - everything
// else above is parsed, never re-typed). Used only to build TABLE_OVERVIEW below.
const TABLE_SUMMARIES = {
  BookingMaster: 'the central table: holds BOTH quotations and confirmed bookings - guest info, travel dates, statuses, agent, staff who booked it',
  Agents: 'travel agents who book on behalf of guests',
  Destination: "destination master list (Bangkok, Phuket, ...); BookingMaster's own destinations are a comma-separated list of these Ids",
  BookingHotel: 'hotels booked for a trip/itinerary, with per-stay rate and total cost',
  BookingHotelAttributeMapping: 'extra/optional charges added to a hotel booking (extra bed, extra breakfast, extra meals, ...)',
  AttributeType: 'lookup of extra-charge types (extra bed, extra breakfast, extra meals, ...)',
  HotelMaster: "a hotel stay's confirmation/payment/deadline status, split direct-hotel vs OTA-booked",
  Hotel: 'hotel master directory - name, address, default rate per night',
  HotelRoomType: 'room types and their rates for a hotel',
  BookingItineary: "day-by-day itinerary/activities for a trip (transfers, sightseeing, etc.) - this is where a booking's PICKUP POINT lives (PickupPointId), always include this table for any pickup-point question",
  BookingItineraryRestaurant: 'meal/restaurant bookings for a trip (lunch/dinner coupons)',
  BookingMemberType: 'pricing per traveler type (adult/child/infant) for a booking',
  JobSheetMaster: "operations job sheet - vendor/vehicle/meal dispatch status for each itinerary line item; \"vendor confirmation\"/\"customer update\"/\"lunch status\"/\"dinner status\" questions live here",
  AccountMaster: 'chart of accounts / ledger accounts - hotels, vendors, agents as accounts',
  AccountGroup: 'grouping/category for AccountMaster rows',
  AccountTransaction: 'ledger transactions/payments - the core accounting table; also where Credit/Debit/Balance rules for a hotel vendor account live',
  PaymentMaster: 'payment status and paid amount for a booking',
  ReceivableMaster: 'amounts receivable tied to a booking',
  FinancialYear: 'financial year date ranges, and which one is currently active',
  Inquiry: 'pre-sales customer inquiries, which may later convert into a booking',
  InquiryStatus: 'lookup of inquiry status names',
  InquiryTaskLog: 'follow-up log entries for an inquiry',
  Pickup: 'pickup point master list - to find which one applies to a specific booking, also include BookingItineary (linked via its PickupPointId)',
  VehicalMaster: 'vehicle master list (name, capacity)',
  TransferVehicalMapping: 'vehicle pricing for transfers',
  RestaurantMaster: 'restaurant master list with lunch/dinner pricing',
  RoomPricing: 'date-ranged pricing for a hotel room type',
  Particular: 'itinerary activity/particular master list with pricing',
  ConversionMaster: 'currency conversion rates (THB/USD) by date range',
};

function buildTableOverview() {
  const lines = TABLE_NAMES.map((n) => `- ${n}: ${TABLE_SUMMARIES[n] || '(see full schema on request)'}`);
  return `${SCHEMA_PREAMBLE}\n\nTables in this database:\n${lines.join('\n')}`;
}

// Tables that are commonly CONFUSED with, or whose correct handling depends on, another table -
// selecting one without its counterpart risks exactly the class of bug this two-tier system exists
// to avoid. Hotel/HotelRoomType (the generic hotel directory) vs BookingHotel (what was actually
// booked for a specific trip) is the clearest case - reproduced live: "hotel per night amount of cb"
// (cb is a GUEST) selected only Hotel/HotelRoomType, so the guest-resolution rule (which lives in
// BookingHotel's own detail, right next to a note saying to join through BookingMaster) never even
// reached the model, and it searched the Hotel master table's own name column instead and found
// nothing. Applied automatically in buildSchemaDoc below - the caller never has to know these exist.
const ALWAYS_INCLUDE_WITH = {
  Hotel: ['BookingHotel'],
  HotelRoomType: ['BookingHotel'],
  HotelMaster: ['BookingHotel'],
};

// Full schema context for the Planner: complete detail for just the given tables, plus the
// always-included general rules. Falls back to EVERY table if tableNames is missing/empty/matches
// nothing real - safer to send the whole thing (the old behavior) than to silently hand the model
// no schema at all because table-selection came back empty or garbled.
function buildSchemaDoc(tableNames) {
  const requested = Array.isArray(tableNames) ? tableNames.filter((n) => n in TABLE_DETAILS) : [];
  if (!requested.length) {
    return `${SCHEMA_PREAMBLE}\n\n${TABLE_NAMES.map((n) => TABLE_DETAILS[n]).join('\n\n')}\n\n${GENERAL_RULES}`;
  }

  // BookingMaster is the central table nearly every real question touches, directly or via a join
  // (guest/agent/staff lookups, date filters, status checks, "for X"/"of X" guest resolution, ...) -
  // always include it even if the Understand step didn't explicitly name it, rather than trust
  // table-selection to catch every indirect case.
  const names = new Set(['BookingMaster', ...requested]);
  for (const n of requested) {
    for (const friend of ALWAYS_INCLUDE_WITH[n] || []) names.add(friend);
  }
  const ordered = TABLE_NAMES.filter((n) => names.has(n));
  return `${SCHEMA_PREAMBLE}\n\n${ordered.map((n) => TABLE_DETAILS[n]).join('\n\n')}\n\n${GENERAL_RULES}`;
}

// TRIED AND REVERTED: a single fixed-size, always-all-tables "medium detail" doc (columns only, no
// per-table "reproduced live" rules) for a merged one-call Understand+Plan flow in chat.js. Measured
// live: no meaningful token saving over the two-call buildSchemaDoc(tableNames) path above (~6,185
// vs ~6,082 tokens on a clean run), and worse when the leaner schema caused a first-attempt SQL
// error needing a retry (up to ~11,138 tokens - reproduced live: "show bookings for agent Blue Star
// Travel and Tourism" hallucinated a nonexistent bm.TotalAmount column 2 times out of 3 identical
// attempts). Removed rather than left as dead code; buildTableOverview + buildSchemaDoc above are
// the two-call design actually in use.

module.exports = { SCHEMA_DOC, TABLE_NAMES, buildTableOverview, buildSchemaDoc };
