import { SenderError, schema, table, t } from "spacetimedb/server";

const potentialAction = t.object("PotentialAction", {
  name: t.string(),
  baseCost: t.f64(),
});

const sensorSnapshot = t.object("SensorSnapshot", {
  sensorId: t.string(),
  startedAt: t.i64(),
  generated: t.bool(),
  custom: t.bool(),
  name: t.string(),
  kind: t.string(),
  value: t.string(),
  severityLevel: t.i32(),
  x: t.f64(),
  y: t.f64(),
  area: t.string(),
  message: t.string(),
  advice: t.option(t.string()),
  operations: t.option(t.string()),
  timeToActSeconds: t.option(t.i64()),
  costGrowthPerSecond: t.f64(),
  actions: t.array(potentialAction),
  acknowledged: t.bool(),
  dismissed: t.bool(),
  acknowledgedAt: t.option(t.i64()),
});

const activitySnapshot = t.object("ActivitySnapshot", {
  time: t.i64(),
  text: t.string(),
  tone: t.string(),
});

const feedSettings = table(
  {
    name: "feed_settings",
    indexes: [
      { accessor: "byOwnerFeed", algorithm: "btree", columns: ["owner", "feed"] },
    ],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    owner: t.identity(),
    feed: t.string(),
    selectedSensorId: t.option(t.string()),
    area: t.u16(),
    zoom: t.f64(),
    filter: t.string(),
    autoGenerateAlerts: t.bool(),
    lastCheck: t.i64(),
    alertStartedAt: t.i64(),
  }
);

const siteSensor = table(
  {
    name: "site_sensor",
    indexes: [
      { accessor: "byOwnerFeed", algorithm: "btree", columns: ["owner", "feed"] },
    ],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    owner: t.identity(),
    feed: t.string(),
    sensorId: t.string(),
    startedAt: t.i64(),
    generated: t.bool(),
    custom: t.bool(),
    name: t.string(),
    kind: t.string(),
    value: t.string(),
    severityLevel: t.i32(),
    x: t.f64(),
    y: t.f64(),
    area: t.string(),
    message: t.string(),
    advice: t.option(t.string()),
    operations: t.option(t.string()),
    timeToActSeconds: t.option(t.i64()),
    costGrowthPerSecond: t.f64(),
    actions: t.array(potentialAction),
    acknowledged: t.bool(),
    dismissed: t.bool(),
    acknowledgedAt: t.option(t.i64()),
  }
);

const activityEntry = table(
  {
    name: "activity_entry",
    indexes: [
      { accessor: "byOwnerFeed", algorithm: "btree", columns: ["owner", "feed"] },
    ],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    owner: t.identity(),
    feed: t.string(),
    position: t.u32(),
    time: t.i64(),
    text: t.string(),
    tone: t.string(),
  }
);

const spacetimedb = schema({ feedSettings, siteSensor, activityEntry });
export default spacetimedb;

export const myFeedSettings = spacetimedb.view(
  { name: "my_feed_settings", public: true },
  t.array(feedSettings.rowType),
  (ctx) => [...ctx.db.feedSettings.byOwnerFeed.filter(ctx.sender)]
);

export const mySensors = spacetimedb.view(
  { name: "my_sensors", public: true },
  t.array(siteSensor.rowType),
  (ctx) => [...ctx.db.siteSensor.byOwnerFeed.filter(ctx.sender)]
);

export const myActivity = spacetimedb.view(
  { name: "my_activity", public: true },
  t.array(activityEntry.rowType),
  (ctx) => [...ctx.db.activityEntry.byOwnerFeed.filter(ctx.sender)]
);

export const syncFeed = spacetimedb.reducer(
  {
    feed: t.string(),
    selectedSensorId: t.option(t.string()),
    area: t.u16(),
    zoom: t.f64(),
    filter: t.string(),
    autoGenerateAlerts: t.bool(),
    lastCheck: t.i64(),
    alertStartedAt: t.i64(),
    sensors: t.array(sensorSnapshot),
    activities: t.array(activitySnapshot),
  },
  (ctx, snapshot) => {
    const {
      feed,
      selectedSensorId,
      area,
      zoom,
      filter,
      autoGenerateAlerts,
      lastCheck,
      alertStartedAt,
      sensors,
      activities,
    } = snapshot;

    if (feed !== "simulated" && feed !== "live") {
      throw new SenderError("Feed must be simulated or live.");
    }
    if (area !== 160 && area !== 400 && area !== 640) {
      throw new SenderError("Site area must be 160, 400, or 640 acres.");
    }
    if (filter !== "all" && filter !== "alerts") {
      throw new SenderError("Sensor filter must be all or alerts.");
    }
    if (sensors.length > 1000 || activities.length > 10) {
      throw new SenderError("Feed snapshot exceeds the supported size.");
    }
    if (!Number.isFinite(zoom) || zoom < 0.75 || zoom > 1.35) {
      throw new SenderError("Zoom must be between 0.75 and 1.35.");
    }
    if (new Set(sensors.map((sensor) => sensor.sensorId)).size !== sensors.length) {
      throw new SenderError("Sensor IDs must be unique within a feed.");
    }
    if (selectedSensorId != null && !sensors.some((sensor) => sensor.sensorId === selectedSensorId)) {
      throw new SenderError("Selected sensor must belong to this feed.");
    }
    for (const sensor of sensors) {
      if (
        sensor.sensorId.length > 120
        || sensor.name.length > 80
        || sensor.kind.length > 60
        || sensor.value.length > 40
        || sensor.area.length > 60
        || sensor.message.length > 320
        || (sensor.advice != null && sensor.advice.length > 300)
        || (sensor.operations != null && sensor.operations.length > 120)
        || sensor.severityLevel < 1
        || sensor.severityLevel > 3
        || !Number.isFinite(sensor.x)
        || sensor.x < 0
        || sensor.x > 100
        || !Number.isFinite(sensor.y)
        || sensor.y < 0
        || sensor.y > 100
        || !Number.isFinite(sensor.costGrowthPerSecond)
        || sensor.costGrowthPerSecond < 0
        || (sensor.timeToActSeconds != null && sensor.timeToActSeconds < 1n)
        || sensor.actions.some((action) => (
          action.name.length > 100
          || !Number.isFinite(action.baseCost)
          || action.baseCost < 0
        ))
      ) {
        throw new SenderError(`Sensor ${sensor.sensorId} contains invalid data.`);
      }
    }
    if (activities.some((activity) => (
      activity.text.length > 320
      || (activity.tone !== "normal" && activity.tone !== "warning" && activity.tone !== "alarm")
    ))) {
      throw new SenderError("Activity entries contain invalid data.");
    }

    const settingsRows = [...ctx.db.feedSettings.byOwnerFeed.filter([ctx.sender, feed])];
    const settings = {
      owner: ctx.sender,
      feed,
      selectedSensorId,
      area,
      zoom,
      filter,
      autoGenerateAlerts,
      lastCheck,
      alertStartedAt,
    };
    if (settingsRows.length === 0) {
      ctx.db.feedSettings.insert({ id: 0n, ...settings });
    } else {
      ctx.db.feedSettings.id.update({ ...settingsRows[0], ...settings });
      for (const duplicate of settingsRows.slice(1)) {
        ctx.db.feedSettings.id.delete(duplicate.id);
      }
    }

    const existingSensors = [...ctx.db.siteSensor.byOwnerFeed.filter([ctx.sender, feed])];
    const existingBySensorId = new Map(existingSensors.map((sensor) => [sensor.sensorId, sensor]));
    const incomingSensorIds = new Set(sensors.map((sensor) => sensor.sensorId));
    for (const sensor of sensors) {
      const row = {
        owner: ctx.sender,
        feed,
        ...sensor,
      };
      const existing = existingBySensorId.get(sensor.sensorId);
      if (existing) {
        ctx.db.siteSensor.id.update({ ...existing, ...row });
      } else {
        ctx.db.siteSensor.insert({ id: 0n, ...row });
      }
    }
    for (const existing of existingSensors) {
      if (!incomingSensorIds.has(existing.sensorId)) {
        ctx.db.siteSensor.id.delete(existing.id);
      }
    }

    const existingActivities = [...ctx.db.activityEntry.byOwnerFeed.filter([ctx.sender, feed])];
    const activitiesByPosition = new Map(existingActivities.map((entry) => [entry.position, entry]));
    activities.forEach((activity, position) => {
      const row = { owner: ctx.sender, feed, position, ...activity };
      const existing = activitiesByPosition.get(position);
      if (existing) {
        ctx.db.activityEntry.id.update({ ...existing, ...row });
      } else {
        ctx.db.activityEntry.insert({ id: 0n, ...row });
      }
    });
    for (const existing of existingActivities) {
      if (existing.position >= activities.length) {
        ctx.db.activityEntry.id.delete(existing.id);
      }
    }
  }
);
