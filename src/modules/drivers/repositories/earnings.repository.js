const pool = require("../../../config/db");

/**
 * What a driver actually earned, out of the rides they actually finished.
 *
 * There is no earnings table and nothing writes one: every figure below is
 * summed from `trips` at read time. That is the whole point — a dashboard
 * fed by a column somebody has to remember to update is a dashboard that
 * disagrees with the receipts.
 *
 * Money is DECIMAL, which mysql2 hands back as a string; the callers turn
 * it into a number. Dates are formatted in SQL rather than parsed in JS,
 * because the pool runs at +08:00 and a Date built from that string in a
 * process running at UTC is a day out either side of midnight.
 */

/**
 * The week the driver is in, from the database's clock.
 *
 * Monday-first: WEEKDAY() is 0 on Monday whatever the server's locale
 * thinks the week starts on, which DAYOFWEEK() does not promise. Which bar
 * is "today" is the app's to decide — it knows what the phone says the
 * date is, and this server does not.
 */
async function weekWindow() {
  const [rows] = await pool.query(
    `SELECT DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY), '%Y-%m-%d') AS week_start,
            DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS today`,
  );
  return rows[0];
}

/**
 * One row per day this driver completed anything, inside the week.
 *
 * Grouped by the DROPOFF, not the booking: a ride booked before midnight
 * and finished after it is money earned on the day it was paid for.
 * `final_fare` is what the ride settled at and `estimated_fare` the figure
 * the passenger agreed to; completing a trip copies one into the other, so
 * the COALESCE only ever matters for a row written before that ran.
 */
async function dailyTotals(driverId, weekStart) {
  const [rows] = await pool.query(
    `SELECT DATE_FORMAT(t.dropoff_at, '%Y-%m-%d') AS day,
            COUNT(*) AS trips_count,
            SUM(COALESCE(t.final_fare, t.estimated_fare, 0)) AS gross
       FROM trips t
      WHERE t.driver_id = :driverId
        AND t.status = 'completed'
        AND t.dropoff_at >= :weekStart
        AND t.dropoff_at <  DATE_ADD(:weekStart, INTERVAL 7 DAY)
      GROUP BY day
      ORDER BY day ASC`,
    { driverId, weekStart },
  );
  return rows;
}

module.exports = { weekWindow, dailyTotals };
