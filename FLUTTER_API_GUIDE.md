# YushiGo — Flutter Implementation Guide

Covers every endpoint the mobile apps need (rider app + driver/partner app), the Socket.IO
realtime contract, and the payment flows. Written against the actual backend in `Backend/src`.

---

## 0. Ground rules (read this first, it saves you a week)

| Thing | Value |
|---|---|
| Base URL | `https://yushigo.com/api/v1` (`/api` is an alias mount — same router, use `/api/v1`) |
| Socket.IO | `https://yushigo.com` (default path `/socket.io`) |
| Static files | `https://yushigo.com/uploads/...` |
| Health check | `GET https://yushigo.com/health` |
| Auth header | `Authorization: Bearer <jwt>` |
| Body format | JSON only. **There is no multipart anywhere** — images go up as base64 data URLs |
| Max body | 25 MB |

### Response envelope

Every success:

```json
{ "success": true, "data": { } }
```

Every failure (`Backend/src/modules/taxi/middlewares/errorMiddleware.js`):

```json
{ "success": false, "message": "human readable", "details": {} }
```

Mongoose validation failures return `{ success:false, message:"Validation failed", errors:[...] }`,
duplicate keys return 409 `{ success:false, message:"Duplicate value error", details:{...} }`.

So: unwrap `data` in one place, never per-call.

### JWT + roles

`signAccessToken({ sub, role })` — payload is `{ sub: <mongo id>, role }`. Roles that exist:

`user`, `driver`, `owner`, `pooling_driver`, `bus_driver`, `service_center`,
`service_center_staff`, `admin`.

The **same driver app binary serves 6 of those roles**. `POST /drivers/auth/verify-otp` tells you
which role the token carries — branch your home screen on it, don't hardcode `driver`.

Auth failures worth handling explicitly:

| Status | `message` | Meaning |
|---|---|---|
| 401 | `jwt expired` | token expired → force re-login (there is **no refresh token endpoint**) |
| 401 | `Invalid authorization token` | garbage / tampered token |
| 401 | `Authenticated account no longer exists` | account deleted server-side |
| 403 | `Driver account is pending approval` | onboarding not approved → show pending screen |
| 403 | `... is inactive` | blocked account |

Some driver endpoints pass `allowPending: true` (`/drivers/me`, `/drivers/fcm-token`,
`/drivers/documents/*`) so a pending driver can still see their status and re-upload documents.
Everything else 403s until approved.

### Rate limits

Server-side limits exist on: login, OTP send, OTP verify, ride creation, payment order creation,
and `GET /rides/available-drivers`. On breach you get 429 with a message. The socket `requestRide`
event is limited to **10 per 10 minutes**. Debounce "available drivers" polling to >= 5s and never
retry a 429 immediately.

### Images

`POST /common/upload/image` — public, no auth.

```json
{ "image": "data:image/jpeg;base64,/9j/4AAQ...", "folder": "profile" }
```

returns `{ "success": true, "data": { "url": "...", "publicId": "...", "format": "jpg" } }`.

Upload first, then send the returned `url` string in whatever field wants an image.
Compress before encoding — base64 inflates ~33% and the cap is 25 MB for the whole request.

---

## 1. Project setup

```yaml
dependencies:
  dio: ^5.4.0
  socket_io_client: ^2.0.3+1        # MUST be v2 -> Socket.IO server v4
  flutter_secure_storage: ^9.0.0
  flutter_riverpod: ^2.4.0          # or provider/bloc, doesn't matter
  google_maps_flutter: ^2.5.0
  geolocator: ^11.0.0
  firebase_core: ^2.24.0
  firebase_messaging: ^14.7.0
  razorpay_flutter: ^1.3.7
  url_launcher: ^6.2.0              # PhonePe redirect
  image_picker: ^1.0.7
  flutter_image_compress: ^2.1.0
```

Folder layout — keep it flat, this API is wide but shallow:

```
lib/
  core/    api_client.dart  socket_service.dart  token_store.dart
  models/  ride.dart  user.dart  driver.dart      # only where it earns its keep
  api/     auth_api.dart  ride_api.dart  wallet_api.dart ...
  features/...
```

**Do not generate a Dart model for all ~350 endpoints.** Type the six payloads you touch on every
screen (ride realtime state, user, driver, wallet, vehicle type, socket ride request) and read the
rest straight off `Map<String, dynamic>`. Half of this API is admin CRUD you'll never call.

---

## 2. Core plumbing

### `core/api_client.dart`

```dart
import 'package:dio/dio.dart';

class ApiException implements Exception {
  ApiException(this.status, this.message, this.body);
  final int status;
  final String message;
  final dynamic body;
  bool get isAuthExpired => status == 401;
  bool get isPendingApproval => status == 403 && message.contains('pending approval');
  @override
  String toString() => message;
}

class ApiClient {
  ApiClient(this._tokens) {
    dio = Dio(BaseOptions(
      baseUrl: 'https://yushigo.com/api/v1',
      connectTimeout: const Duration(seconds: 15),
      receiveTimeout: const Duration(seconds: 30),
      headers: {'Content-Type': 'application/json'},
    ));

    dio.interceptors.add(InterceptorsWrapper(onRequest: (o, h) async {
      final t = await _tokens.read();
      if (t != null) o.headers['Authorization'] = 'Bearer $t';
      h.next(o);
    }));
  }

  final TokenStore _tokens;
  late final Dio dio;

  /// Unwraps { success, data } — every endpoint in this backend uses it.
  Future<T> _send<T>(Future<Response> Function() run) async {
    try {
      final res = await run();
      final body = res.data;
      if (body is Map && body['success'] == false) {
        throw ApiException(res.statusCode ?? 0, '${body['message']}', body);
      }
      return (body is Map ? body['data'] : body) as T;
    } on DioException catch (e) {
      final body = e.response?.data;
      if (body is Map && body['message'] != null) {
        throw ApiException(e.response?.statusCode ?? 0, '${body['message']}', body);
      }
      throw ApiException(0, e.message ?? 'Network error', null);
    }
  }

  Future<T> get<T>(String p, {Map<String, dynamic>? query}) =>
      _send<T>(() => dio.get(p, queryParameters: query));
  Future<T> post<T>(String p, [Object? body]) => _send<T>(() => dio.post(p, data: body));
  Future<T> patch<T>(String p, [Object? body]) => _send<T>(() => dio.patch(p, data: body));
  Future<T> delete<T>(String p, [Object? body]) => _send<T>(() => dio.delete(p, data: body));
}
```

That's the whole HTTP layer. Every API file below is one-liners on top of it.

### `core/token_store.dart`

```dart
class TokenStore {
  static const _k = 'auth_token', _kRole = 'auth_role';
  final _s = const FlutterSecureStorage();
  Future<String?> read() => _s.read(key: _k);
  Future<String?> role() => _s.read(key: _kRole);
  Future<void> save(String token, String role) async {
    await _s.write(key: _k, value: token);
    await _s.write(key: _kRole, value: role);
  }
  Future<void> clear() => _s.deleteAll();
}
```

There is no refresh endpoint. On `401 jwt expired`: clear storage, drop to the login screen.
Token lifetime comes from server env (`JWT_EXPIRES_IN`) — don't assume a value, just react to 401.

### `core/socket_service.dart`

The token goes in the **handshake `auth`**, not a header (server reads `socket.handshake.auth.token`).

```dart
import 'package:socket_io_client/socket_io_client.dart' as IO;

class SocketService {
  IO.Socket? _s;
  IO.Socket get socket => _s!;

  void connect(String jwt) {
    _s?.dispose();
    _s = IO.io('https://yushigo.com', IO.OptionBuilder()
        .setTransports(['websocket'])
        .setAuth({'token': jwt})           // <- server reads handshake.auth.token
        .enableReconnection()
        .setReconnectionDelay(1000)
        .setReconnectionDelayMax(8000)
        .build());

    _s!.onConnect((_) => _s!.emit('ride:rejoin-current')); // survive app restarts
    _s!.on('errorMessage', (d) => debugPrint('socket error: ${d['message']}'));
    _s!.connect();
  }

  void disconnect() { _s?.dispose(); _s = null; }
  void on(String e, void Function(dynamic) f) => _s?.on(e, f);
  void off(String e) => _s?.off(e);
  void emit(String e, [Object? d]) => _s?.emit(e, d);
}
```

Connect **right after login** and keep it alive for the whole session. The server:

- auto-joins you to `user:<id>` / `driver:<id>` and the support-chat rooms on connect;
- for drivers, writes `socketId` onto the Driver document — **if the socket is down the driver
  receives no `rideRequest` events** (they still get an FCM push, see §12);
- clears `socketId` on disconnect.

**On every cold start and app-resume, emit `ride:rejoin-current`.** It rejoins the active ride room
and replies with `ride:state` (or `null`). That's how you restore an in-progress ride.

---

# PART A — RIDER APP

## 3. Auth (user)

Primary flow is OTP. Password login exists as a fallback.

| Method | Path | Auth | Body / notes |
|---|---|---|---|
| POST | `/users/auth/send-otp` | – | `{ phone }` 10 digits (leading `91` is stripped server-side) |
| POST | `/users/auth/verify-otp` | – | `{ phone, otp }` 4 digits |
| POST | `/users/signup` | – | after a verified OTP session |
| POST | `/users/register` | – | direct register, no OTP session required |
| POST | `/users/login` | – | `{ phone, password }` |
| POST | `/users/otp-login` | – | `{ phone }` → `{ exists, token?, user? }` |

OTP is **4 digits**, TTL **10 minutes**. In non-production the OTP is echoed back as
`data.session.debugOtp` — handy for staging, `null` in production.

`send-otp` → `201`:

```json
{ "success": true, "data": {
  "message": "OTP sent successfully",
  "exists": true,
  "session": { "phone": "9876543210", "status": "otp_sent", "debugOtp": null } } }
```

`verify-otp` branches — **this is the important bit**:

```jsonc
// existing user -> you are logged in, no signup screen
{ "success": true, "data": { "exists": true, "token": "ey...",
  "user": { "id": "...", "name": "", "phone": "", "email": "", "gender": "", "currentRideId": null } } }

// new user -> verified session held for 10 min, now call /users/signup
{ "success": true, "data": { "exists": false, "phone": "9876543210",
  "session": { "phone": "...", "status": "otp_verified", "debugOtp": null } } }
```

`POST /users/signup` body (call within 10 min of verify):

```json
{ "name": "Om", "phone": "9876543210", "email": "om@x.com", "countryCode": "+91",
  "gender": "male", "profileImage": "<url from /common/upload/image>",
  "referralCode": "USR1234ABCDEF", "employeeCode": "EMP01",
  "governmentIdProof": { "type": "aadhaar", "number": "...", "image": "<url>" } }
```

Bad referral / employee code → `400 Invalid referral code`. Existing active phone → `409`.
A soft-deleted account is silently reactivated by signup.

```dart
class AuthApi {
  AuthApi(this._c);
  final ApiClient _c;

  Future<Map<String, dynamic>> sendOtp(String phone) =>
      _c.post('/users/auth/send-otp', {'phone': phone});

  Future<Map<String, dynamic>> verifyOtp(String phone, String otp) =>
      _c.post('/users/auth/verify-otp', {'phone': phone, 'otp': otp});

  Future<Map<String, dynamic>> signup(Map<String, dynamic> body) =>
      _c.post('/users/signup', body);
}

// caller
final r = await auth.verifyOtp(phone, otp);
if (r['exists'] == true) {
  await tokens.save(r['token'], 'user');
  socket.connect(r['token']);
} else {
  goToSignup(phone);                       // 10-minute window
}
```

`currentRideId` on the user payload is non-null when a ride is in flight — use it to jump straight
into the ride screen after login.

## 4. Bootstrap and catalogs

Call `/users/bootstrap` **once on app start** — it is server-side cached and folds five settings
calls into one. Everything else here is a cold-start catalog; cache locally for the session.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/users/bootstrap` | – | modules + general/transport/customization settings + active payment gateway + home layout |
| GET | `/users/app-modules` | – | enabled modules (ride / parcel / medicine / rental / bus / pooling) |
| GET | `/users/settings/:category` | – | `general`, `transport-ride`, `customize`, `user-home-management` |
| GET | `/user-home-management` | – | home screen layout config |
| GET | `/users/vehicle-types` | – | bike/auto/car etc. **`_id` here is the `vehicleTypeId` you must send when booking** |
| GET | `/users/set-prices` | – | fare matrix |
| GET | `/users/zones` | – | operating zones |
| GET | `/users/goods-types` | – | parcel goods categories |
| GET | `/users/intercity-packages` | – | intercity package catalog |
| GET | `/users/rental-vehicles` | – | rental catalog |
| GET | `/users/service-locations` | – | cities served |
| GET | `/users/service-stores` | – | service centers |
| GET | `/common/payment-gateway` | – | which gateway is live (`razorpay` \| `phonepe`) |
| GET | `/common/referrals/translation?language=en` | – | referral copy |
| GET | `/common/referrals/settings?type=user` | – | referral rules |
| GET | `/common/ride_modules` | – | ride module list |
| GET | `/countries` | – | country / dial codes |
| GET | `/on-boarding` | – | onboarding slides |

`bootstrap` shape:

```json
{ "success": true, "data": {
  "modules": [ ... ],
  "settings": { "general": {}, "transportRide": {}, "customization": {},
                "paymentGateway": {}, "userHomeSettings": {} } } }
```

Drive the home screen off `modules` + `userHomeSettings`. Don't hardcode which services exist —
the admin panel toggles them.

## 5. The ride flow (the core of the app)

### 5.1 Statuses

```
status      : searching -> accepted -> ongoing -> completed | cancelled
liveStatus  : searching -> accepted -> arriving -> started -> arrived -> completed | cancelled
```

`status` is the coarse state you show in history. `liveStatus` drives the live screen. `arrived`
means at the destination (after `started`), `arriving` means the driver is en route to pickup.

### 5.2 Endpoints

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/rides/available-drivers` | – | `?vehicleTypeId=&lat=&lng=&maxDistance=&limit=&service_location_id=&transport_type=` — for map pins/ETA. Rate limited. `maxDistance` capped at 25000 m, `limit` at 50 |
| POST | `/rides` | user | create ride (see body below) |
| GET | `/rides` | user, driver | history — `?limit=&page=&category=` → `{ results, total, pagination }` |
| GET | `/rides/active/me` | user, driver | current ride, `data: null` when idle |
| GET | `/rides/:rideId` | participant | full detail |
| GET | `/rides/cancellation-reasons` | user | pick-list for the cancel sheet → `{ reasons: [{ code, label }] }` |
| PATCH | `/rides/:rideId/cancel` | user | `{ reasonCode?, reasonNote? }` — see §Cancellation reasons |
| PATCH | `/rides/:rideId/status` | driver | `{ status, paymentMethod? }` |
| PATCH | `/rides/:rideId/feedback` | user | rating/review |
| GET | `/rides/app-settings/tip` | – | tip presets |
| GET | `/rides/:rideId/bids` | user | driver bids |
| PATCH | `/rides/:rideId/bids/ceiling` | user | `{ incrementSteps }` raise max fare |
| POST | `/rides/:rideId/bids/:bidId/accept` | user | pick a bid |
| GET | `/common/track/:token` | – | public share-my-ride tracking |

### Cancellation reasons

Before cancelling, show the rider a reason sheet. Load the list once per session from
`GET /rides/cancellation-reasons` — don't hardcode it, codes can be added server-side:

```json
{ "reasons": [ { "code": "driver_taking_too_long", "label": "Driver is taking too long" }, ... ] }
```

Then send the chosen code with the cancel call:

```
PATCH /rides/:rideId/cancel
{ "reasonCode": "driver_taking_too_long", "reasonNote": "" }
```

Rules the server enforces:

- `reasonCode` must be one of the codes from the list — anything else is `400 reasonCode is invalid`.
- `reasonCode: "other"` **requires** a non-empty `reasonNote`, else `400`.
- `reasonNote` is capped at 500 characters.
- Both fields are optional today so older builds keep working; a cancel with no reason is stored as
  `reasonCode: "unspecified"`. Treat the sheet as mandatory in the app.

The response echoes what was recorded, and the assigned driver receives the reason on the
`rideRequestClosed` socket event as `cancellation: { cancelledBy, reasonCode, reasonLabel, reasonNote }`.

`POST /rides` body — `pickup`, `drop`, `vehicleTypeId` are mandatory:

```json
{ "pickup": { "lat": 22.71, "lng": 75.85 },
  "drop":   { "lat": 22.75, "lng": 75.89 },
  "pickupAddress": "Vijay Nagar", "dropAddress": "Airport",
  "fare": 240, "estimatedDistanceMeters": 8200, "estimatedDurationMinutes": 22,
  "vehicleTypeId": "<_id from /users/vehicle-types>",
  "vehicleTypeIds": ["..."], "vehicleIconType": "car", "vehicleIconUrl": "...",
  "paymentMethod": "cash", "serviceType": "ride",
  "promo_code": "SAVE50", "zone_id": "...", "service_location_id": "...",
  "transport_type": "...", "scheduledAt": null,
  "bookingMode": "normal", "userMaxBidFare": 300, "bidStepAmount": 10,
  "intercity": null, "studentSafety": null }
```

Response `201`:

```json
{ "success": true, "data": {
  "ride": { },
  "realtime": { "room": "ride_<id>", "rideId": "<id>" } } }
```

`serviceType` values: `ride`, `parcel`, `medicine`. `bookingMode`: `normal` or bidding —
when the server sets `pricingNegotiationMode` to `driver_bid`, drivers counter-offer and you accept
one via `/rides/:rideId/bids/:bidId/accept`; when it's `user_increment_only`, the rider raises the
ceiling with `/bids/ceiling` and dispatch restarts at the new fare.

Coordinates accept `{lat, lng}` or `[lng, lat]` — send `{lat, lng}`, it's harder to get wrong.
Everything the server returns as GeoJSON is `[lng, lat]`. **Do not mix these up.**

### 5.3 Socket contract — rider side

Emit:

| Event | Payload |
|---|---|
| `ride:join` | `{ rideId }` — join the room (authorization enforced) |
| `ride:rejoin-current` | `{}` — rejoin whatever's active; replies `ride:state` or `null` |
| `ride:message:send` | `{ rideId, message }` |
| `requestRide` | full ride body — socket alternative to `POST /rides` |

Listen:

| Event | When |
|---|---|
| `ride:joined` | `{ rideId, room, rejoined? }` |
| `ride:state` | full serialized ride — **your single source of truth** |
| `ride:status:updated` | `{ rideId, status, liveStatus, acceptedAt, arrivedAt, startedAt, completedAt }` |
| `ride:driver-location:updated` | `{ rideId, coordinates:[lng,lat], heading, speed, updatedAt }` — animate the car |
| `ride:driver-route:updated` | polyline for the driver's route |
| `ride:message:new` | in-ride chat message |
| `rideSearchUpdate` | dispatch progress (radius, attempt, dispatchType) |
| `rideAccepted` | `{ rideId, room, status, liveStatus, otp, driver{...}, vehicleIconUrl }` |
| `rideBidUpdated` | `{ ..., bid }` a driver bid landed |
| `rideCancelled` | ride killed (driver/system/timeout) |
| `rideRequestClosed` | request window closed |
| `driverRejectedRide` | `{ rideId, driverId }` |

**`otp` arrives on `rideAccepted` and inside `ride:state`.** The rider shows it, the driver asks
for it before starting the trip.

`ride:state` (`serializeRideRealtime`) is the payload to model properly:

```jsonc
{
  "rideId": "...", "room": "ride_...", "deliveryId": null,
  "type": "ride", "serviceType": "ride",
  "status": "accepted", "liveStatus": "arriving",
  "fare": 240, "baseFare": 240,
  "bookingMode": "normal", "pricingNegotiationMode": "none", "biddingStatus": "none",
  "bidStepAmount": 10, "bidFloorFare": 240, "userMaxBidFare": 240,
  "bidCeilingMaxFare": 240, "fareIncreaseWaitMinutes": 0, "nextFareIncreaseAt": null,
  "acceptedBidId": null,
  "estimatedDistanceMeters": 8200, "estimatedDurationMinutes": 22,
  "paymentMethod": "cash",
  "subscriptionUsage": null,           // non-null when a plan covered the fare
  "driverPaymentCollection": null,     // driver-side QR/link collection state
  "otp": "1234",
  "parcel": null, "medicine": null, "intercity": null,
  "commissionAmount": 0, "driverEarnings": 0,
  "promo": null, "pricingSnapshot": { },
  "vehicleIconType": "car", "vehicleIconUrl": "...",
  "pickupLocation": { "type": "Point", "coordinates": [75.85, 22.71] },
  "pickupAddress": "...", "dropLocation": { }, "dropAddress": "...",
  "scheduledAt": null,
  "acceptedAt": "...", "arrivedAt": null, "startedAt": null, "completedAt": null,
  "feedback": null,
  "lastDriverLocation": { "coordinates": [75.85,22.71], "heading": 90, "speed": 8, "updatedAt": "..." },
  "user": { }, "driver": { },
  "messages": [ { "id","senderRole","senderId","message","sentAt" } ]   // last 30 only
}
```

`messages` is capped at the last 30 — for older history use `GET /rides/:rideId`.

### 5.4 Wiring it up

```dart
class RideController extends ChangeNotifier {
  RideController(this._api, this._socket);
  final RideApi _api; final SocketService _socket;
  Map<String, dynamic>? ride;
  LatLng? driverPos;

  void bind() {
    _socket.on('ride:state', (d) { if (d != null) { ride = Map<String,dynamic>.from(d); notifyListeners(); } });
    _socket.on('ride:status:updated', (d) {
      ride = {...?ride, 'status': d['status'], 'liveStatus': d['liveStatus']};
      notifyListeners();
    });
    _socket.on('ride:driver-location:updated', (d) {
      final c = d['coordinates'] as List;                 // [lng, lat]
      driverPos = LatLng((c[1] as num).toDouble(), (c[0] as num).toDouble());
      notifyListeners();
    });
    _socket.on('rideAccepted', (d) { ride = {...?ride, ...Map<String,dynamic>.from(d)}; notifyListeners(); });
    _socket.on('rideCancelled', (_) { ride = null; notifyListeners(); });
  }

  Future<void> book(Map<String, dynamic> body) async {
    final res = await _api.create(body);
    _socket.emit('ride:join', {'rideId': res['realtime']['rideId']});
  }

  /// Called on resume — socket may have missed events while backgrounded.
  Future<void> resync() async {
    ride = await _api.active();          // GET /rides/active/me
    _socket.emit('ride:rejoin-current');
    notifyListeners();
  }
}
```

**Rule: socket for liveness, REST for truth.** Whenever the app comes to foreground, call
`GET /rides/active/me` and re-emit `ride:rejoin-current` — don't trust that the socket stayed alive.

## 6. Paying for a ride

Three ways to settle: cash (nothing to call), wallet, or gateway.

| Method | Path | Body |
|---|---|---|
| POST | `/rides/:rideId/complete-payment/wallet` | `{}` |
| POST | `/rides/:rideId/complete-payment/razorpay/order` | `{}` → `{ keyId, orderId, amount, currency, callbackUrl }` |
| POST | `/rides/:rideId/complete-payment/razorpay/verify` | `{ razorpay_order_id, razorpay_payment_id, razorpay_signature }` |
| POST | `/rides/:rideId/tip/razorpay/order` | `{ amount }` |
| POST | `/rides/:rideId/tip/razorpay/verify` | same triple |

`amount` in the order response is **paise** — pass it to the Razorpay SDK unchanged.

```dart
Future<void> payWithRazorpay(String rideId) async {
  final o = await api.post('/rides/$rideId/complete-payment/razorpay/order');
  _razorpay.open({
    'key': o['keyId'],
    'order_id': o['orderId'],
    'amount': o['amount'],              // paise, already correct
    'currency': o['currency'],
    'name': 'YushiGo',
  });
}

void _onSuccess(PaymentSuccessResponse r) => api.post(
  '/rides/$rideId/complete-payment/razorpay/verify',
  {'razorpay_order_id': r.orderId,
   'razorpay_payment_id': r.paymentId,
   'razorpay_signature': r.signature});
```

**The payment is not applied until you call `verify`.** If the app dies between checkout and
verify, re-fetch the ride on next launch and check `driverPaymentCollection.status`.

PhonePe is redirect-based: create the order, `url_launcher` the returned URL, then poll
`GET .../phonepe/status/:merchantTransactionId` when the app comes back to foreground.

Which gateway to show comes from `GET /common/payment-gateway` (also in bootstrap).

## 7. Wallet, subscriptions, promos

**Wallet**

| Method | Path | Body |
|---|---|---|
| GET | `/users/wallet` | balance + transactions |
| POST | `/users/wallet/topup` | `{ amount }` (direct/admin credit path) |
| POST | `/users/wallet/transfer` | user → user |
| POST | `/users/wallet/transfer/driver` | pay a driver from wallet |
| POST | `/users/wallet/razorpay/order` | `{ amount }` (rupees) → order |
| POST | `/users/wallet/razorpay/verify` | `{ razorpay_order_id, razorpay_payment_id, razorpay_signature }` |
| POST | `/users/wallet/phonepe/order` | `{ amount }` |
| GET | `/users/wallet/phonepe/status/:merchantTransactionId` | poll |

Note the asymmetry: you send **rupees** in the order request, you receive **paise** in the
order response. Both order endpoints are rate limited.

`/users/wallet/razorpay/callback` (GET+POST) is the gateway's server-to-server webhook — never
call it from the app.

**Subscriptions**

| Method | Path |
|---|---|
| GET | `/users/subscriptions/plans` |
| GET | `/users/subscriptions/me` |
| POST | `/users/subscriptions/purchase` |

When a plan covers a ride, `ride:state.subscriptionUsage` comes back non-null with
`fareCovered` and `ridesRemainingAfter` — surface that instead of a fare on the receipt.

**Promos**

| Method | Path | Body / query |
|---|---|---|
| POST | `/promos/validate` | `{ code, fare, service_location_id, transport_type }` |
| GET | `/promos/available` | `?service_location_id=` **required** (400 without it), `&transport_type=&limit=` |

Validate before booking, then pass `promo_code` in the `POST /rides` body — the server re-checks it.

## 8. Profile, notifications, safety

| Method | Path | Notes |
|---|---|---|
| GET | `/users/me` | profile |
| PATCH | `/users/me` | partial update |
| PUT | `/users/me/guardian-contacts` | guardian list (student-safety feature) |
| POST | `/users/profile-image` | base64 image |
| POST | `/users/me/delete-request` | account deletion request (admin approves) |
| POST | `/users/fcm-token` | `{ token, platform }` |
| GET | `/users/notifications` | list |
| DELETE | `/users/notifications/:id` | one |
| DELETE | `/users/notifications` | clear all |
| POST | `/users/sos` | SOS alert → admin dashboard |

Notifications serialize as `{ id, title, body, image, sentAt, serviceLocationId }`.

Call `POST /users/fcm-token` after login **and** on every `onTokenRefresh`. Without it the user
gets zero push.

## 9. Parcel and medicine delivery

Same ride engine underneath — `serviceType` is `parcel` / `medicine` and a `Delivery` doc is
linked. Live tracking uses the exact same socket events.

**Parcel**

| Method | Path | Auth |
|---|---|---|
| POST | `/deliveries` | user |
| GET | `/deliveries` | user |
| GET | `/deliveries/active/me` | user, driver |
| GET | `/deliveries/:deliveryId` | participant |

**Medicine**

| Method | Path | Auth |
|---|---|---|
| GET | `/medicine-orders/pharmacies` | user |
| POST | `/medicine-orders` | user |
| GET | `/medicine-orders` | user |
| GET | `/medicine-orders/active/me` | user, driver |
| GET | `/medicine-orders/:medicineOrderId` | participant |

Medicine delivery types: `home_to_pharmacy`, `pharmacy_to_home`, `hospital_pickup`,
`document_pickup`, `sample_pickup`, `return_pickup`.

Use `GET /users/goods-types` for the parcel category picker. Reuse your ride live-tracking screen
verbatim — `ride:state` carries `parcel` / `medicine` sub-objects and `deliveryId`.

## 10. Rentals, buses, pooling

**Rentals** (self-drive / packaged)

| Method | Path | Auth |
|---|---|---|
| GET | `/users/rental-vehicles` | – |
| POST | `/users/rental-quote-requests` | – |
| POST | `/users/rental-bookings` | user |
| GET | `/users/rental-bookings` | user |
| GET | `/users/rental-bookings/active` | user |
| POST | `/users/rental-bookings/:id/location` | user — push GPS while the rental is running |
| POST | `/users/rental-bookings/:id/end` | user |
| POST | `/users/rental-advance/razorpay/order` \| `/verify` | user |
| POST | `/users/rental-advance/phonepe/order` , GET `/status/:merchantTransactionId` | user |
| POST | `/users/rental-advance/wallet` | user |

Rental tracking is **REST polling**, not sockets — post `/location` on a timer (30–60s) while
the booking is active.

**Buses**

| Method | Path |
|---|---|
| GET | `/users/buses/routes` |
| GET | `/users/buses/search` |
| GET | `/users/buses/:id/seats` |
| POST | `/users/bus-bookings/order` → `/users/bus-bookings/verify` |
| GET | `/users/bus-bookings` , `/users/bus-bookings/:id` |
| POST | `/users/bus-bookings/:id/cancel` |
| POST | `/users/bus-bookings/:id/review` |

All bus endpoints require a user token. Seats are held server-side between `order` and `verify` —
don't let the user idle on the payment screen.

**Pooling**

| Method | Path |
|---|---|
| GET | `/users/pooling/search` |
| GET | `/users/pooling/routes/:id` |
| POST | `/users/pooling/bookings/order` → `/users/pooling/bookings/verify` |
| POST | `/users/pooling/bookings` (no-payment path) |
| GET | `/users/pooling/bookings` |

## 11. Support and chat (both apps)

**Tickets** — `user`, `driver`, `owner`:

| Method | Path |
|---|---|
| GET | `/support/titles` |
| POST | `/support/tickets` |
| GET | `/support/tickets/my` |
| GET | `/support/tickets/:ticketCode` |
| POST | `/support/tickets/:ticketCode/reply` |

**Live chat with admin** — `/chats/*`, whole router is authenticated (`admin`, `user`, `driver`):

| Method | Path |
|---|---|
| GET | `/chats/conversations` |
| GET | `/chats/messages/:conversationKey` |
| PATCH | `/chats/messages/:conversationKey/read` |
| POST | `/chats/messages` |
| DELETE | `/chats/messages/:conversationKey` |

Socket side: emit `chat:join {conversationKey}`, `chat:send {message, receiverRole, receiverId, conversationKey}`,
`chat:read {conversationKey}`. You're auto-joined to your participant room on connect, so incoming
messages arrive without joining anything.

**Careers** (public): `GET /careers/jobs`, `POST /careers/applications`, `POST /careers/upload`.

## 12. Push notifications

FCM via `firebase-admin` server-side. Register the token after login and on refresh:

- rider: `POST /users/fcm-token` `{ token, platform }`
- driver: `POST /drivers/fcm-token` (allowed while pending approval)

Driver ride-request push data payload:

```json
{ "type": "ride_request", "rideId": "...", "serviceType": "ride", "userId": "..." }
```

Treat push as a **wake-up, not a source of truth** — on tap, fetch `GET /rides/:rideId` (or
`/rides/active/me`) and drive the UI from that.

---

# PART B — DRIVER / PARTNER APP

## 13. Driver auth

| Method | Path | Body |
|---|---|---|
| POST | `/drivers/auth/send-otp` | `{ phone }` → `{ message, session, availableRoles }` |
| POST | `/drivers/auth/verify-otp` | `{ phone, otp, role? }` |
| POST | `/drivers/login` | `{ phone, password }` |
| POST | `/drivers/register` | direct register |
| GET | `/drivers/approval-status` | public — poll while pending |

**Multi-role is the thing to get right.** One phone number can be a driver *and* a fleet owner
*and* a bus driver. `send-otp` returns `availableRoles`. If there's more than one, `verify-otp`
returns:

```json
{ "success": true, "data": {
  "message": "OTP verified successfully. Multiple roles detected.",
  "needsRoleSelection": true,
  "availableRoles": ["driver", "owner"] } }
```

Show a role picker, then call `verify-otp` again with `{ phone, otp, role }` to get:

```json
{ "success": true, "data": { "message": "OTP verified successfully",
  "token": "ey...", "role": "driver", "driver": { } } }
```

```dart
Future<void> driverLogin(String phone, String otp, [String? role]) async {
  final r = await api.post('/drivers/auth/verify-otp',
      {'phone': phone, 'otp': otp, if (role != null) 'role': role});
  if (r['needsRoleSelection'] == true) {
    return showRolePicker(List<String>.from(r['availableRoles']));
  }
  await tokens.save(r['token'], r['role']);
  socket.connect(r['token']);
  routeByRole(r['role']);   // driver | owner | bus_driver | pooling_driver | service_center | service_center_staff
}
```

## 14. Driver onboarding wizard

Session-based, **unauthenticated** — you carry a `registrationId` between steps, no token yet.

| Step | Method | Path |
|---|---|---|
| 1 | POST | `/drivers/onboarding/send-otp` |
| 2 | POST | `/drivers/onboarding/verify-otp` → `registrationId` |
| 3 | GET | `/drivers/onboarding/signup-options` |
| 4 | PATCH | `/drivers/onboarding/role` |
| 5 | PATCH | `/drivers/onboarding/role-details` |
| 6 | PATCH | `/drivers/onboarding/personal` |
| 7 | PATCH | `/drivers/onboarding/referral` |
| 8 | PATCH | `/drivers/onboarding/vehicle` |
| 8b | POST | `/drivers/onboarding/vehicle/verify-rc` |
| 9 | PATCH | `/drivers/onboarding/documents` |
| 9b | POST | `/drivers/onboarding/documents/:documentKey/verify-license` |
| 10 | POST | `/drivers/onboarding/complete` |
| any | GET | `/drivers/onboarding/session/:registrationId` — **resume** |

Supporting catalogs: `GET /drivers/document-templates`, `GET /drivers/vehicle-field-templates`,
`GET /drivers/service-locations` — all public. The document templates tell you which documents are
required and their `documentKey`s; render the upload screen from that list rather than hardcoding.

**Persist `registrationId` to disk immediately.** Users abandon onboarding constantly; the session
endpoint is what lets them come back.

Pooling drivers have a parallel flow: `/drivers/pooling/onboarding/{send-otp, verify-otp,
session/:registrationId, details, complete, upload-image}`.

After `complete`, the account is pending until an admin approves. Poll `GET /drivers/approval-status`
or let them log in — `/drivers/me` works while pending (`allowPending`).

## 15. Going online and receiving rides

| Method | Path | Notes |
|---|---|---|
| PATCH | `/drivers/online` | `{ location: {lat,lng}, selfieImageUrl }` |
| PATCH | `/drivers/offline` | `{}` |

`goOnline` **will 400** if:
- no selfie was taken today → `"A selfie is required before going online today"` (one selfie per
  calendar day; upload via `/common/upload/image` first);
- the wallet balance is too low (non-fleet drivers only) — negative-balance drivers can't accept rides.

Handle both explicitly or your drivers will be stuck on a spinner.

Once online, the driver must have a **live socket** to get dispatched.

### Driver socket contract

Emit:

| Event | Payload |
|---|---|
| `locationUpdate` | `{ coordinates: {lat,lng} }` — every few seconds while online |
| `acceptRide` | `{ rideId }` |
| `rejectRide` | `{ rideId }` |
| `submitRideBid` | `{ rideId, bidFare }` |
| `ride:driver-location:update` | `{ rideId, coordinates, heading, speed }` — during an active ride |
| `ride:status:update` | `{ rideId, status, paymentMethod? }` |

Listen:

| Event | Meaning |
|---|---|
| `rideRequest` | new job offer (full payload below) |
| `rideRequestClosed` | offer withdrawn — someone else took it / cancelled / expired |
| `rideAccepted` | your accept won the race |
| `rideBidSubmitted` | your bid registered |
| `driver:wallet:updated` | `{ wallet, transaction }` after a completed ride |
| `ride:state`, `ride:status:updated`, `ride:driver-route:updated`, `ride:message:new` | shared with rider |

`rideRequest` payload:

```jsonc
{
  "rideId": "...", "type": "ride", "serviceType": "ride",
  "userId": "...", "user": { "id","name","phone","countryCode" },
  "pickupLocation": {"type":"Point","coordinates":[lng,lat]}, "pickupAddress": "...",
  "dropLocation": { }, "dropAddress": "...",
  "scheduledAt": null,
  "estimatedDistanceMeters": 8200, "estimatedDurationMinutes": 22,
  "vehicleTypeId": "...", "vehicleTypeIds": ["..."], "vehicleIconType": "car", "vehicleIconUrl": "...",
  "fare": 240, "baseFare": 240,
  "bookingMode": "normal", "pricingNegotiationMode": "none", "biddingStatus": "none",
  "bidding": { "enabled": false },     // or { enabled:true, baseFare, bidFloorFare, userMaxBidFare, bidCeilingMaxFare, bidStepAmount }
  "fareIncreaseWaitMinutes": 0, "nextFareIncreaseAt": null,
  "paymentMethod": "cash", "parcel": null, "intercity": null,
  "radius": 4000, "attempt": 1, "maxAttempts": 5,
  "acceptRejectDurationSeconds": 20, "expiresInSeconds": 20,
  "requestExpiresAt": "2026-08-25T10:00:20.000Z",
  "zoneId": "..."
}
```

Drive the accept/reject countdown off **`requestExpiresAt`** (absolute ISO timestamp), not
`expiresInSeconds` — the latter drifts with network latency.

```dart
void bindDriverSocket() {
  socket.on('rideRequest', (d) {
    final expiry = DateTime.parse(d['requestExpiresAt']);
    showOfferSheet(d, expiry);
  });
  socket.on('rideRequestClosed', (d) => dismissOffer(d['rideId']));

  // Socket-loss recovery: on cold start / app-resume / reconnect, call
  // GET /drivers/ride-offers -> { offers: [ <same payload as `rideRequest`> ] }
  // Any offer missed while the socket was down comes back here. Offers already
  // rejected, taken by another driver, or expired are omitted.
  socket.on('driver:wallet:updated', (d) => wallet.value = d['wallet']);

  Timer.periodic(const Duration(seconds: 4), (_) async {
    if (!isOnline) return;
    final p = await Geolocator.getCurrentPosition();
    socket.emit('locationUpdate', {'coordinates': {'lat': p.latitude, 'lng': p.longitude}});
    if (activeRideId != null) {
      socket.emit('ride:driver-location:update', {
        'rideId': activeRideId, 'coordinates': {'lat': p.latitude, 'lng': p.longitude},
        'heading': p.heading, 'speed': p.speed});
    }
  });
}
```

The server throttles its own writes (persists location only past ~25 m or 15 s; ride location past
~12 m or 4 s), so a 3–5 s client cadence is fine and won't hammer the DB. Use a foreground service
on Android — a killed socket means no jobs.

**Accepting is a race.** Multiple drivers get the same `rideRequest` in broadcast mode; only the
first `acceptRide` transaction wins, the rest get an `errorMessage`. Show "ride already taken",
don't treat it as a crash.

### Status progression (driver)

Either socket `ride:status:update` or `PATCH /rides/:rideId/status`. Allowed values:
`accepted` → `arriving` → `started` → `arrived` → `completed`.

Ask the rider for the **4-digit OTP** before `started` — it's on the ride payload.
On `completed`, the server settles the wallet and emits `driver:wallet:updated` with the commission
already deducted.

## 16. Driver money

| Method | Path | Notes |
|---|---|---|
| GET | `/drivers/wallet` | balance + transactions |
| POST | `/drivers/wallet/top-up` | direct |
| POST | `/drivers/wallet/top-up/razorpay/order` \| `/verify` | rate limited |
| POST | `/drivers/wallet/top-up/phonepe/order` , GET `/status/:merchantTransactionId` | |
| POST | `/drivers/wallet/withdrawals` | payout request → admin approves |
| POST | `/drivers/payments/qr` | generate a UPI QR to collect cash-alternative payment |
| GET | `/drivers/payments/qr/status` | poll until paid |
| GET | `/drivers/incentives` | incentive progress |
| POST | `/drivers/incentives/claim` | claim reward |

Bank/UPI verification before payouts: `POST /drivers/me/bank-details/verify`, `POST /drivers/me/upi/verify`.

The QR flow mirrors into the ride's `driverPaymentCollection` block, so the rider's screen updates
too. Poll `/payments/qr/status` while the QR sheet is open, stop when it leaves `pending`.

## 17. Driver profile and documents

| Method | Path | Notes |
|---|---|---|
| GET | `/drivers/me` | works while pending |
| PATCH | `/drivers/me` | `driver`, `owner` |
| DELETE | `/drivers/me` | hard delete |
| POST | `/drivers/me/delete-request` | request deletion |
| PATCH | `/drivers/vehicle` | update vehicle |
| PATCH | `/drivers/documents/:documentKey` | re-upload a document (pending allowed) |
| POST | `/drivers/documents/:documentKey/verify-{license,pan,gst,rc,bank}` | third-party verification |
| GET | `/drivers/notifications` | |
| GET | `/drivers/ride-offers` | open offers already sent to you — socket-loss recovery, see below |
| GET | `/drivers/scheduled-rides` | pre-booked rides |
| POST | `/drivers/scheduled-rides/:rideId/cancel` | |
| GET/POST/DELETE | `/drivers/emergency-contacts[/:contactId]` | |
| POST | `/drivers/sos` | `driver`, `owner` |

## 18. Fleet owner (`role: owner`)

| Method | Path |
|---|---|
| GET | `/drivers/fleet/dashboard` |
| GET/POST/PATCH/DELETE | `/drivers/fleet/drivers[/:driverId]` |
| GET/POST/PATCH/DELETE | `/drivers/fleet/vehicles[/:vehicleId]` |
| GET | `/drivers/fleet/zones` |
| GET/POST/PATCH/DELETE | `/drivers/fleet/pooling-vehicles[/:vehicleId]` |
| GET/POST/PATCH/DELETE | `/drivers/fleet/bus-services[/:id]` |
| GET | `/drivers/fleet/bus-bookings` , `/drivers/fleet/bus-bookings/calendar` |
| POST | `/drivers/fleet/bus-bookings/:id/cancel` |

## 19. Bus driver (`role: bus_driver`)

| Method | Path |
|---|---|
| GET | `/drivers/bus/seats` |
| GET | `/drivers/bus/bookings` |
| POST | `/drivers/bus/reservations` |
| GET | `/drivers/bus/live-trip` |
| POST | `/drivers/bus/live-trip/start` |
| PATCH | `/drivers/bus/live-trip/location` |
| PATCH | `/drivers/bus/live-trip/status` |
| PATCH | `/drivers/bus/schedules` |

Bus live-trip location is **REST polling** (`PATCH /bus/live-trip/location`), not the socket.
Post every 15–30 s while a trip is running.

## 20. Service center (`role: service_center` / `service_center_staff`)

| Method | Path |
|---|---|
| GET/POST/PATCH/DELETE | `/drivers/service-center/staff[/:staffId]` |
| GET | `/drivers/service-center/staff/:staffId/biometrics` |
| POST | `/drivers/service-center/staff/biometrics/enroll` |
| GET | `/drivers/service-center/bookings` |
| PATCH | `/drivers/service-center/bookings/:bookingId` |
| GET/PATCH | `/drivers/service-center/bookings/:bookingId/biometrics` |
| POST | `/drivers/service-center/bookings/:bookingId/biometrics/fingers` |
| DELETE | `/drivers/service-center/bookings/:bookingId/biometrics/fingers/:fingerCode` |
| POST | `/drivers/service-center/bookings/:bookingId/biometrics/verify` |
| GET/POST/PATCH/DELETE | `/drivers/service-center/vehicles[/:vehicleId]` |

Fingerprint capture needs external hardware/SDK — plan a platform channel, not a pure-Dart package.

## 21. Pooling driver (`role: pooling_driver`)

`GET /drivers/pooling/bookings` (works while pending) plus the onboarding endpoints in §14.
A pooling token is issued against a `PoolingVehicle`, not a `Driver` — the account also 403s if
`poolingEnabled` is false or the vehicle status is `inactive` / `maintenance`.

---

## 22. Admin API (not for the mobile apps)

~170 endpoints under `/admin/*` back the React web panel: dashboard, users, drivers, owners,
zones, service locations, vehicle types, set-prices, promos, banners, notifications, wallets,
withdrawals, reports, integration settings, support, careers, pooling, buses, rentals, safety
alerts, pharmacies, subscriptions. All require an `admin` token (`POST /admin/login`).

Skip these in Flutter unless you're building an admin app. If you do, the list is in
`Backend/src/modules/taxi/admin/routes/adminRoutes.js` and
`Backend/src/modules/taxi/admin/promotions/routes/promotionsRoutes.js`.

---

## 23. Build order

1. `ApiClient` + `TokenStore` + `SocketService` + error mapping — nothing else works without them.
2. Rider OTP auth → bootstrap → home.
3. Ride booking + live tracking (§5). **This is 60% of the app** — get `ride:state` right and the
   parcel, medicine and delivery screens are near-free.
4. Payments + wallet.
5. Driver auth + onboarding + online/offline + `rideRequest` handling.
6. Delivery / medicine (reuses §5 wholesale).
7. Rentals, buses, pooling — independent, ship them last.
8. Support, chat, notifications, SOS.

## 24. Gotchas that will bite you

1. **Coordinates.** Requests take `{lat, lng}`; every response is GeoJSON `[lng, lat]`. One
   conversion helper, used everywhere.
2. **No token refresh.** 401 `jwt expired` = re-login. Build that path early.
3. **Base64 uploads only.** No `MultipartFile` anywhere in this API.
4. **Socket token is in `auth`, not headers.** Wrong placement = silent connection failure.
5. **`ride:rejoin-current` on every resume.** Otherwise a backgrounded app shows a stale ride.
6. **Driver socket = driver income.** No socket, no `rideRequest`. Foreground service on Android,
   and reconnect aggressively.
7. **Payment verify is mandatory.** Order alone doesn't credit anything.
8. **`vehicleTypeId` is a Mongo `_id`** from `/users/vehicle-types` — not the string `"car"`.
   `POST /rides` 400s without it.
9. **Selfie gate on going online.** Once per calendar day, checked server-side.
10. **Driver multi-role.** Handle `needsRoleSelection` or owners can't log in.
11. **`/promos/available` needs `service_location_id`** or it 400s.
12. **`messages` in `ride:state` is only the last 30.** Full history via `GET /rides/:rideId`.
13. **429s are real.** Back off on OTP, login, ride create, payment orders, available-drivers.
14. **`status` vs `liveStatus`.** History uses `status`; the live screen needs `liveStatus`
    (`arriving` = heading to pickup, `arrived` = at destination).
