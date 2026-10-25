// Reference decoder for the M0 corpus test: decodes every attributedBody with
// Apple's own NSUnarchiver and prints "rowid \t status \t sha256(utf8) \t bytes".
// Only hashes leave this program, never message text.
//
// Build: clang -fobjc-arc -framework Foundation -lsqlite3 reference.m -o reference

#import <Foundation/Foundation.h>
#import <CommonCrypto/CommonDigest.h>
#import <sqlite3.h>

static NSString *sha256Hex(NSData *data) {
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
  NSMutableString *hex = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
  for (int i = 0; i < CC_SHA256_DIGEST_LENGTH; i++) [hex appendFormat:@"%02x", digest[i]];
  return hex;
}

int main(int argc, char **argv) {
  @autoreleasepool {
    if (argc < 2) {
      fprintf(stderr, "usage: reference <path to chat.db>\n");
      return 2;
    }
    NSString *uri = [NSString stringWithFormat:@"file:%s?mode=ro", argv[1]];
    sqlite3 *db;
    if (sqlite3_open_v2(uri.UTF8String, &db, SQLITE_OPEN_READONLY | SQLITE_OPEN_URI, NULL) != SQLITE_OK) {
      fprintf(stderr, "open failed: %s\n", sqlite3_errmsg(db));
      return 1;
    }
    sqlite3_stmt *stmt;
    sqlite3_prepare_v2(db,
      "SELECT ROWID, attributedBody FROM message WHERE attributedBody IS NOT NULL ORDER BY ROWID",
      -1, &stmt, NULL);

    while (sqlite3_step(stmt) == SQLITE_ROW) {
      @autoreleasepool {
        sqlite3_int64 rowid = sqlite3_column_int64(stmt, 0);
        NSData *blob = [NSData dataWithBytes:sqlite3_column_blob(stmt, 1)
                                      length:(NSUInteger)sqlite3_column_bytes(stmt, 1)];
        NSString *status = @"ok";
        NSString *hash = @"-";
        NSUInteger bytes = 0;
        @try {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
          id obj = [NSUnarchiver unarchiveObjectWithData:blob];
#pragma clang diagnostic pop
          if ([obj isKindOfClass:[NSAttributedString class]]) {
            NSData *utf8 = [[obj string] dataUsingEncoding:NSUTF8StringEncoding];
            if (utf8) {
              hash = sha256Hex(utf8);
              bytes = utf8.length;
            } else {
              status = @"badutf8";
            }
          } else {
            status = @"notattr";
          }
        } @catch (NSException *e) {
          status = @"exception";
        }
        printf("%lld\t%s\t%s\t%lu\n", rowid, status.UTF8String, hash.UTF8String, (unsigned long)bytes);
      }
    }
    sqlite3_finalize(stmt);
    sqlite3_close(db);
  }
  return 0;
}
