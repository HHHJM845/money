package `fun`.huangjiamu.money.ui
import org.junit.Assert.assertEquals
import org.junit.Test
class KeypadTest {
    @Test fun decimalAndDelete() {
        assertEquals("0.", keypadAmount("", "."))
        assertEquals("1.2", keypadAmount("1.2", "."))
        assertEquals("1.23", keypadAmount("1.23", "4"))
        assertEquals("1.2", keypadAmount("1.23", "⌫"))
        assertEquals("", keypadAmount("", "⌫"))
        assertEquals("4", keypadAmount("0", "4"))
        assertEquals("123456789012345678", keypadAmount("123456789012345678", "9"))
    }
}
