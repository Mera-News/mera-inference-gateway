// Stub for expo-server-sdk used in e2e tests. The real package ships ESM that
// clashes with ts-jest's CommonJS transform, and the e2e suite never sends a
// push, so a no-op stand-in is sufficient.
class Expo {
  static isExpoPushToken() {
    return true;
  }
  chunkPushNotifications(messages) {
    return [messages];
  }
  async sendPushNotificationsAsync() {
    return [];
  }
}

module.exports = { Expo };
