const ROLE_TABLES = {
  rider: {
    table: "customers",
    idColumn: "user_id",
    hasPhoneLogin: true,
    hasGoogle: true,
  },
  driver: {
    table: "drivers",
    idColumn: "driver_id",
    hasPhoneLogin: true,
    hasGoogle: false,
  },
  admin: {
    table: "admins",
    idColumn: "admin_id",
    hasPhoneLogin: false,
    hasGoogle: false,
  },
};

function getRoleConfig(role) {
  return ROLE_TABLES[role] || null;
}

module.exports = { ROLE_TABLES, getRoleConfig };
