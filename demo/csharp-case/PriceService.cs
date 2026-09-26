namespace PocketPilotDemo;
public class PriceService
{
    public int FinalPrice(int amount, int? percent)
    {
        return amount - (amount * percent.Value / 100);
    }
}
