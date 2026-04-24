namespace DataCentral.AppStarter.Api.Models;

public sealed class LegacyDcData
{
    public int UserId { get; set; }
    public string UserName { get; set; } = "";
    public string UserDisplayName { get; set; } = "";
    public string TenancyName { get; set; } = "";
    public int TenantId { get; set; }
    public List<string> RoleDisplayNames { get; set; } = new();
    public List<int> RoleIds { get; set; } = new();
    public string ClientUrl { get; set; } = "";
    public string TimeStamp { get; set; } = "";
    public List<string> AllowedGroupIds { get; set; } = new();
}
