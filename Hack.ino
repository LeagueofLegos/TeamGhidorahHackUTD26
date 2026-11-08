const int trigPin = 2;
const int echoPin = 3;

// Baseline configuration
const float emptyCupDistance = 6.19; // Inches when cup is completely empty
const float maxWaterHeight = 5.0;    // Maximum usable water height (for 100% capacity)

// Variables for flow rate calculation
float previousWaterHeight = 0.0;
unsigned long previousMillis = 0;
const unsigned long interval = 1000; // Calculate every 1 second

void setup() {
  Serial.begin(9600);
  pinMode(trigPin, OUTPUT);
  pinMode(echoPin, INPUT);
}

void loop() {
  // 1. Check if the web page sent any commands down the serial line
  if (Serial.available() > 0) {
    String command = Serial.readStringUntil('\n');
    command.trim();
    if (command == "RESET") {
      // Handle any reset logic here if needed
      previousWaterHeight = 0.0;
    }
  }

  // 2. Trigger ultrasonic pulse
  digitalWrite(trigPin, LOW);
  delayMicroseconds(2);
  digitalWrite(trigPin, HIGH);
  delayMicroseconds(10);
  digitalWrite(trigPin, LOW);

  long duration = pulseIn(echoPin, HIGH, 30000);

  if (duration > 0) {
    // Convert duration to distance in inches
    float currentDistance = (duration * 0.0343 / 2.0) / 2.54;

    // Calculate water height
    float waterHeight = emptyCupDistance - currentDistance;
    if (waterHeight < 0) waterHeight = 0.0;
    if (waterHeight > emptyCupDistance) waterHeight = emptyCupDistance;

    unsigned long currentMillis = millis();
    float flowRateInchesPerSec = 0.0;

    // 3. Every 1 second, calculate flow rate
    if (currentMillis - previousMillis >= interval) {
      float heightDifference = waterHeight - previousWaterHeight;
      flowRateInchesPerSec = heightDifference / ((currentMillis - previousMillis) / 1000.0);

      previousWaterHeight = waterHeight;
      previousMillis = currentMillis;
    }

    // Calculate capacity percentage
    float capacityPercent = (waterHeight / maxWaterHeight) * 100.0;
    if (capacityPercent > 100.0) capacityPercent = 100.0;

    // Determine status string for operator dashboard
    String status = "NORMAL";
    if (capacityPercent >= 85.0) {
      status = "CRITICAL";
    } else if (capacityPercent >= 65.0) {
      status = "WARNING";
    }

    // 4. Print clean JSON payload for your web page to parse
    Serial.print("{\"distance\": ");
    Serial.print(currentDistance, 2);
    Serial.print(", \"water_height\": ");
    Serial.print(waterHeight, 2);
    Serial.print(", \"capacity_percent\": ");
    Serial.print(capacityPercent, 1);
    Serial.print(", \"status\": \"");
    Serial.print(status);
    Serial.println("\"}");

  } else {
    // Report timeout error in JSON format so the web page doesn't break
    Serial.println("{\"error\": \"SENSOR_TIMEOUT\", \"status\": \"UNKNOWN\"}");
  }

  delay(200); // Update frequency
}