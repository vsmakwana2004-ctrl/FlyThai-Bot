// Maps each DB table documented in schema.js's SCHEMA_DOC to the FlyThai admin-panel permission
// page that governs it, so the NL-to-SQL path (chat.js's runReadOnlyQuery call) can check the
// asking role's `view` permission on every table a generated query actually touches. Hand-maintained
// since schema.js is a plain prose doc with no category metadata of its own - update this alongside
// schema.js whenever a table is added/renamed. Tables not listed here are treated as unmapped
// (always allowed) - currently only ConversionMaster (currency rates, no page equivalent).
const TABLE_PERMISSION_MAP = {
  BookingMaster: 'Booking',
  BookingHotel: 'Booking',
  BookingHotelAttributeMapping: 'Booking',
  AttributeType: 'Booking',
  HotelMaster: 'Booking',
  BookingItineary: 'Booking',
  BookingItineraryRestaurant: 'Booking',
  BookingMemberType: 'Booking',

  Hotel: 'Hotels Configuration',
  HotelRoomType: 'Hotels Configuration',
  RoomPricing: 'Hotels Configuration',

  Agents: 'Agents Configuration',

  Destination: 'Manage Destinations',

  JobSheetMaster: 'Job Sheet',

  AccountMaster: 'Account Master',
  AccountGroup: 'Account Master',
  AccountTransaction: 'Account Master',
  PaymentMaster: 'Account Master',
  ReceivableMaster: 'Account Master',

  FinancialYear: 'Manage Financial Year',

  Inquiry: 'Inquiry',
  InquiryStatus: 'Inquiry',
  InquiryTaskLog: 'Inquiry',

  Pickup: 'Manage PickUp Points',

  VehicalMaster: 'Manage Transfers & Sight Seeing',
  TransferVehicalMapping: 'Manage Transfers & Sight Seeing',
  Particular: 'Manage Transfers & Sight Seeing',

  RestaurantMaster: 'Restaurant Configuration',
};

module.exports = { TABLE_PERMISSION_MAP };
