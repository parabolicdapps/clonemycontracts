import Foundation
import Security

/// Generic-password items, one per secret id (e.g. "provider:openai"). The engine never touches the Keychain;
/// it gets keys over its stdin and asks us to persist changes over its stdout.
enum Keychain {
    static let service = "com.parabolicdapps.clonemycontracts"

    private static func base(_ id: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: id]
    }

    @discardableResult
    static func set(_ id: String, _ value: String) -> Bool {
        let data = Data(value.utf8)
        let update = SecItemUpdate(base(id) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if update == errSecSuccess { return true }
        var add = base(id)
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlocked
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    static func get(_ id: String) -> String? {
        var q = base(id)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }

    @discardableResult
    static func delete(_ id: String) -> Bool {
        let s = SecItemDelete(base(id) as CFDictionary)
        return s == errSecSuccess || s == errSecItemNotFound
    }

    static func all() -> [String: String] {
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                kSecReturnAttributes as String: true, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitAll]
        q[kSecUseDataProtectionKeychain as String] = false
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let rows = out as? [[String: Any]] else { return [:] }
        var m: [String: String] = [:]
        for r in rows { if let a = r[kSecAttrAccount as String] as? String, let d = r[kSecValueData as String] as? Data, let s = String(data: d, encoding: .utf8) { m[a] = s } }
        return m
    }
}
