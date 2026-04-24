using DataCentral.AppStarter.Api.Services;
using Microsoft.AspNetCore.Mvc;

namespace DataCentral.AppStarter.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
public sealed class MeController : ControllerBase
{
    private readonly IDataCentralLaunchVerifier _verifier;
    private readonly IWebHostEnvironment _environment;

    public MeController(IDataCentralLaunchVerifier verifier, IWebHostEnvironment environment)
    {
        _verifier = verifier;
        _environment = environment;
    }

    [HttpGet]
    public IActionResult Get()
    {
        var context = _verifier.VerifyFromHeaders(Request.Headers);

        if (context is null && _environment.IsDevelopment())
        {
            return Ok(new
            {
                isVerified = false,
                mode = "development",
                message = "No valid DataCentral signature was provided. Development mode allows frontend demo context."
            });
        }

        if (context is null)
            return Unauthorized(new { message = "Invalid or missing DataCentral launch signature." });

        return Ok(context);
    }
}
