package `fun`.huangjiamu.money.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Only an encrypted owner cookie is persisted. Passwords never enter storage. */
interface SessionStorage {
    fun load(): String?
    fun save(cookie: String)
    fun clear()
}

class SecureSession(context: Context) : SessionStorage {
    private val preferences = context.getSharedPreferences("owner_session_encrypted", Context.MODE_PRIVATE)
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    @Synchronized override fun load(): String? {
        val value = preferences.getString("ciphertext", null) ?: return null
        return try {
            val bytes = Base64.decode(value, Base64.NO_WRAP)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
            String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8)
                .takeIf { it.startsWith("money_session=") }
        } catch (_: Exception) {
            clear()
            null
        }
    }
    @Synchronized override fun save(cookie: String) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val value = Base64.encodeToString(cipher.iv + cipher.doFinal(cookie.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
        check(preferences.edit().putString("ciphertext", value).commit()) { "安全会话保存失败，请检查存储空间" }
    }
    @Synchronized override fun clear() {
        check(preferences.edit().clear().commit()) { "安全会话清除失败，请检查存储空间后再次退出" }
    }
    companion object { private const val ALIAS = "money-owner-cookie-v1" }
}
