// Direct touch injection into a booted iOS Simulator through the guest's `dtuhidd` digitizer
// service, without XCTest. One long-lived process serves one Simulator: the host writes one JSON
// request per line on stdin and reads one JSON reply per line on stdout. EOF on stdin ends it.
//
// The wire shapes follow idb's DTUHID transport (MIT), see LICENSE.idb beside this file:
// FBSimulatorControl/HID/SimulatorDigitizerHIDTransport.swift, DTUHIDModels.swift,
// SimulatorDTUHIDConnection.swift and FBSimulatorControl/XPC/SimulatorXPCConnection.swift.
// CoreSimulator 1155.4 (Xcode 27) and later drop the legacy Indigo input path, so this helper speaks
// only the DTUHID service and refuses at startup when it cannot reach it.

#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#import <dlfcn.h>
#import <mach/mach.h>
#import <objc/message.h>
#import <xpc/xpc.h>

static NSString *const RunnerDigitizerService = @"com.apple.coredevice.feature.remote.hid.digitizer";
static const uint64_t DigitizerEventStart = 0;
static const uint64_t DigitizerEventEnd = 2;
static const uint64_t KeyboardStateUp = 2;
// The connect-time liveness reply pays for dtuhidd's demand launch (idb `DTUHIDTiming.livenessTimeout`).
static const int64_t LivenessTimeoutMs = 4000;
// After the first reply the daemon still opens its device; idb waits this tail once (`replyTail`).
static const useconds_t DeviceOpenTailUs = 200 * 1000;
// A tap's own barrier reply normally takes a few milliseconds.
static const int64_t TapBarrierTimeoutMs = 1000;
static const double MaxHoldMs = 2000;

typedef xpc_object_t (*EndpointFromPort)(mach_port_t, uint64_t, uint64_t);
typedef xpc_connection_t (*ConnectionFromEndpoint)(xpc_object_t);
typedef void (*EnableSim2Host)(xpc_connection_t);

static void emit(NSDictionary *object) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:object options:0 error:NULL];
  if (data == nil) return;
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
  fflush(stdout);
}

static double nowMs(void) {
  return CFAbsoluteTimeGetCurrent() * 1000.0;
}

static id sendObject(id target, NSString *selectorName) {
  SEL selector = NSSelectorFromString(selectorName);
  if (target == nil || ![target respondsToSelector:selector]) return nil;
  return ((id (*)(id, SEL))objc_msgSend)(target, selector);
}

// The SimDevice for `udid`, through the same CoreSimulator service context Xcode uses.
static id findDevice(NSString *developerDir, NSString *udid, NSString **failure) {
  if (dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW) == NULL) {
    *failure = @"coresimulator-unavailable";
    return nil;
  }
  Class contextClass = NSClassFromString(@"SimServiceContext");
  SEL sharedSelector = NSSelectorFromString(@"sharedServiceContextForDeveloperDir:error:");
  if (contextClass == Nil || ![contextClass respondsToSelector:sharedSelector]) {
    *failure = @"service-context-unavailable";
    return nil;
  }
  NSError *error = nil;
  id context = ((id (*)(id, SEL, NSString *, NSError **))objc_msgSend)(contextClass, sharedSelector, developerDir, &error);
  SEL setSelector = NSSelectorFromString(@"defaultDeviceSetWithError:");
  if (context == nil || ![context respondsToSelector:setSelector]) {
    *failure = @"service-context-unavailable";
    return nil;
  }
  id deviceSet = ((id (*)(id, SEL, NSError **))objc_msgSend)(context, setSelector, &error);
  NSDictionary *byUDID = sendObject(deviceSet, @"devicesByUDID");
  id device = byUDID[[[NSUUID alloc] initWithUUIDString:udid]];
  if (device == nil) {
    *failure = @"device-not-found";
    return nil;
  }
  return device;
}

// The device's screen in points, from its device type (pixels over scale).
static CGSize screenPointSize(id device) {
  id deviceType = sendObject(device, @"deviceType");
  SEL sizeSelector = NSSelectorFromString(@"mainScreenSize");
  SEL scaleSelector = NSSelectorFromString(@"mainScreenScale");
  if (![deviceType respondsToSelector:sizeSelector] || ![deviceType respondsToSelector:scaleSelector]) {
    return CGSizeZero;
  }
  CGSize pixels = ((CGSize (*)(id, SEL))objc_msgSend)(deviceType, sizeSelector);
  float scale = ((float (*)(id, SEL))objc_msgSend)(deviceType, scaleSelector);
  if (scale <= 0) return CGSizeZero;
  return CGSizeMake(pixels.width / scale, pixels.height / scale);
}

static xpc_connection_t connectDigitizer(id device, NSString **failure) {
  EndpointFromPort endpointFromPort = (EndpointFromPort)dlsym(RTLD_DEFAULT, "xpc_endpoint_create_mach_port_4sim");
  ConnectionFromEndpoint connectionFromEndpoint =
    (ConnectionFromEndpoint)dlsym(RTLD_DEFAULT, "xpc_connection_create_from_endpoint");
  EnableSim2Host enableSim2Host = (EnableSim2Host)dlsym(RTLD_DEFAULT, "xpc_connection_enable_sim2host_4sim");
  if (endpointFromPort == NULL || connectionFromEndpoint == NULL || enableSim2Host == NULL) {
    *failure = @"xpc-sim-symbols-unavailable";
    return NULL;
  }
  SEL lookupSelector = NSSelectorFromString(@"lookup:error:");
  if (![device respondsToSelector:lookupSelector]) {
    *failure = @"device-lookup-unavailable";
    return NULL;
  }
  NSError *error = nil;
  mach_port_t port = ((mach_port_t (*)(id, SEL, NSString *, NSError **))objc_msgSend)(
    device, lookupSelector, RunnerDigitizerService, &error);
  if (port == MACH_PORT_NULL) {
    *failure = @"digitizer-service-lookup-failed";
    return NULL;
  }
  xpc_object_t endpoint = endpointFromPort(port, 0, 0);
  xpc_connection_t connection = endpoint == NULL ? NULL : connectionFromEndpoint(endpoint);
  if (connection == NULL) {
    *failure = @"digitizer-connection-failed";
    return NULL;
  }
  enableSim2Host(connection);
  xpc_connection_set_target_queue(connection, dispatch_queue_create("agent-device.simulator-hid", NULL));
  xpc_connection_set_event_handler(connection, ^(xpc_object_t event) {
    (void)event;
  });
  xpc_connection_resume(connection);
  return connection;
}

static xpc_object_t envelope(const char *messageType, BOOL isBarrier, xpc_object_t payload) {
  xpc_object_t message = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_string(message, "messageType", messageType);
  xpc_dictionary_set_bool(message, "isBarrier", isBarrier);
  xpc_dictionary_set_string(message, "featureIdentifier", RunnerDigitizerService.UTF8String);
  xpc_dictionary_set_value(message, "payload", payload);
  return message;
}

static xpc_object_t touchMessage(double xRatio, double yRatio, uint64_t eventType) {
  xpc_object_t point = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_double(point, "x", xRatio);
  xpc_dictionary_set_double(point, "y", yRatio);
  xpc_object_t payload = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_value(payload, "pointOne", point);
  xpc_dictionary_set_uint64(payload, "eventType", eventType);
  xpc_dictionary_set_uint64(payload, "edge", 0);
  xpc_dictionary_set_uint64(payload, "target", 0);
  return envelope("IndigoDigitizerEvent", NO, payload);
}

// A keyboard usage 0 ("no event") barrier: the daemon answers it in order behind earlier sends
// without the guest seeing a key (idb `barrierMessage`).
static BOOL roundTripBarrier(xpc_connection_t connection, int64_t timeoutMs) {
  xpc_object_t payload = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_uint64(payload, "usageCode", 0);
  xpc_dictionary_set_uint64(payload, "state", KeyboardStateUp);
  xpc_object_t message = envelope("IndigoKeyboardButtonEvent", YES, payload);
  dispatch_semaphore_t answered = dispatch_semaphore_create(0);
  __block BOOL replied = NO;
  xpc_connection_send_message_with_reply(connection, message, dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^(xpc_object_t reply) {
    replied = xpc_get_type(reply) != XPC_TYPE_ERROR;
    dispatch_semaphore_signal(answered);
  });
  long timedOut = dispatch_semaphore_wait(answered, dispatch_time(DISPATCH_TIME_NOW, timeoutMs * NSEC_PER_MSEC));
  return timedOut == 0 && replied;
}

static NSDictionary *tap(xpc_connection_t connection, CGSize screen, NSDictionary *request) {
  NSNumber *x = request[@"x"], *y = request[@"y"];
  NSNumber *viewportWidth = request[@"viewportWidth"], *viewportHeight = request[@"viewportHeight"];
  if (![x isKindOfClass:NSNumber.class] || ![y isKindOfClass:NSNumber.class]) {
    return @{@"ok": @NO, @"reason": @"invalid-request"};
  }
  // The host's points are the app's. They are the digitizer's portrait points only when the app's
  // root fills the portrait screen; anything else (landscape, a windowed iPad app) goes to XCTest.
  if (![viewportWidth isKindOfClass:NSNumber.class] || ![viewportHeight isKindOfClass:NSNumber.class] ||
      fabs(viewportWidth.doubleValue - screen.width) > 0.5 || fabs(viewportHeight.doubleValue - screen.height) > 0.5) {
    return @{@"ok": @NO, @"reason": @"viewport-not-portrait-screen"};
  }
  double xRatio = x.doubleValue / screen.width, yRatio = y.doubleValue / screen.height;
  if (!(xRatio >= 0 && xRatio <= 1 && yRatio >= 0 && yRatio <= 1)) {
    return @{@"ok": @NO, @"reason": @"point-off-screen"};
  }
  double holdMs = [request[@"holdMs"] isKindOfClass:NSNumber.class] ? [request[@"holdMs"] doubleValue] : 0;
  holdMs = MIN(MAX(holdMs, 0), MaxHoldMs);
  double started = nowMs();
  xpc_connection_send_message(connection, touchMessage(xRatio, yRatio, DigitizerEventStart));
  if (holdMs > 0) usleep((useconds_t)(holdMs * 1000));
  xpc_connection_send_message(connection, touchMessage(xRatio, yRatio, DigitizerEventEnd));
  if (!roundTripBarrier(connection, TapBarrierTimeoutMs)) {
    // The contact may already be down in the guest, so the host must not repeat this tap blindly.
    return @{@"ok": @NO, @"reason": @"barrier-unanswered", @"dispatched": @YES};
  }
  return @{@"ok": @YES, @"elapsedMs": @(nowMs() - started)};
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 3) {
      emit(@{@"ready": @NO, @"reason": @"usage: simulator-hid <developer-dir> <udid>"});
      return 2;
    }
    NSString *failure = nil;
    id device = findDevice(@(argv[1]), @(argv[2]), &failure);
    if (device == nil) {
      emit(@{@"ready": @NO, @"reason": failure});
      return 1;
    }
    CGSize screen = screenPointSize(device);
    if (screen.width <= 0 || screen.height <= 0) {
      emit(@{@"ready": @NO, @"reason": @"screen-size-unavailable"});
      return 1;
    }
    xpc_connection_t connection = connectDigitizer(device, &failure);
    if (connection == NULL) {
      emit(@{@"ready": @NO, @"reason": failure});
      return 1;
    }
    if (!roundTripBarrier(connection, LivenessTimeoutMs)) {
      emit(@{@"ready": @NO, @"reason": @"digitizer-unresponsive"});
      return 1;
    }
    usleep(DeviceOpenTailUs);
    emit(@{@"ready": @YES, @"screenWidth": @(screen.width), @"screenHeight": @(screen.height)});

    char *line = NULL;
    size_t capacity = 0;
    while (getline(&line, &capacity, stdin) > 0) {
      @autoreleasepool {
        NSData *data = [NSData dataWithBytes:line length:strlen(line)];
        id request = [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];
        if (![request isKindOfClass:NSDictionary.class]) {
          emit(@{@"ok": @NO, @"reason": @"invalid-request"});
          continue;
        }
        NSMutableDictionary *reply = [tap(connection, screen, request) mutableCopy];
        if (request[@"id"] != nil) reply[@"id"] = request[@"id"];
        emit(reply);
      }
    }
    free(line);
    xpc_connection_cancel(connection);
  }
  return 0;
}
