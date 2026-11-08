// UNO R4 WiFi USB sensor example. No WiFi, relay, motor, or equipment-control output.
// Assumes an HC-SR04-compatible ultrasonic module. Verify your actual sensor's wiring/specs.
// Connect only a tabletop sensor demo; do not connect oilfield equipment.
const int TRIGGER_PIN = 2;
const int ECHO_PIN = 3;
const int TILT_PIN = 4;
const int SHOCK_PIN = 5;
const int WATER_PIN = A0;
// Measure sensor-to-water distances in your own container before enabling numeric levels.
const bool CALIBRATION_CONFIRMED = false;
const float EMPTY_DISTANCE_CM = 25.0;
const float FULL_DISTANCE_CM = 5.0;
const int WET_ADC_THRESHOLD = 600; // Example only; calibrate your water indicator separately.
unsigned long lastSent = 0;
void setup() {
  Serial.begin(115200);
  pinMode(TRIGGER_PIN, OUTPUT); digitalWrite(TRIGGER_PIN, LOW);
  pinMode(ECHO_PIN, INPUT); pinMode(TILT_PIN, INPUT_PULLUP); pinMode(SHOCK_PIN, INPUT_PULLUP);
}
void loop() {
  if (millis() - lastSent < 1000) return;
  lastSent = millis();
  digitalWrite(TRIGGER_PIN, LOW); delayMicroseconds(2);
  digitalWrite(TRIGGER_PIN, HIGH); delayMicroseconds(10); digitalWrite(TRIGGER_PIN, LOW);
  unsigned long duration = pulseIn(ECHO_PIN, HIGH, 30000);
  float distance = duration * 0.0343f / 2.0f;
  bool valid = CALIBRATION_CONFIRMED && duration > 0 && EMPTY_DISTANCE_CM > FULL_DISTANCE_CM &&
    distance >= FULL_DISTANCE_CM && distance <= EMPTY_DISTANCE_CM;
  // Out-of-range and missing echoes are invalid, never clamped to an apparent safe level.
  float level = 100.0f * (EMPTY_DISTANCE_CM - distance) / (EMPTY_DISTANCE_CM - FULL_DISTANCE_CM);
  Serial.print("{\"device_id\":\"UNO_R4\",\"water_level_pct\":");
  if (valid) Serial.print(level, 2); else Serial.print("null");
  Serial.print(",\"wet\":"); Serial.print(analogRead(WATER_PIN) >= WET_ADC_THRESHOLD ? "true" : "false");
  Serial.print(",\"tilt\":"); Serial.print(digitalRead(TILT_PIN) == LOW ? "true" : "false");
  Serial.print(",\"shock\":"); Serial.print(digitalRead(SHOCK_PIN) == LOW ? "true" : "false");
  Serial.println("}");
}
